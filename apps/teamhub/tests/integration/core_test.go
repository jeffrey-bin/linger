package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
)

const (
	alicePassword = "teamhub-dev-alice"
	acmeTenant    = "tenant_acme"
)

type testEnv struct {
	t                    *testing.T
	databaseURL          string
	pool                 *pgxpool.Pool
	server               *httptest.Server
	application          *app.App
	artifactRoot         string
	broker               *realtime.Broker
	documentRuntimeURL   string
	documentRuntimeToken string
}

func TestCollaborationCore(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	application, err := newIntegrationApp(ctx, config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.CookieSecure = false
	}))
	if err != nil {
		t.Fatalf("new app: %v", err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	idempotencySuffix := fmt.Sprintf("-%d", time.Now().UnixNano())
	idempotencyKey := func(base string) string { return base + idempotencySuffix }
	productionPasswordHash, err := account.HashPassword(alicePassword)
	if err != nil {
		t.Fatalf("hash production-parameter login password: %v", err)
	}
	if _, err := pool.Exec(ctx, "update accounts set password_hash=$1 where id='account_alice'", productionPasswordHash); err != nil {
		t.Fatalf("install production-parameter login password: %v", err)
	}

	t.Run("login accepts correct password and rejects wrong password", func(t *testing.T) {
		client := newClient(t)
		status, _, _ := env.request(client, http.MethodPost, "/v0/auth/login", map[string]any{
			"identifier": "alice@example.com", "password": "",
		}, "")
		if status != http.StatusBadRequest {
			t.Fatalf("empty password status=%d want=400", status)
		}
		status, _, _ = env.request(client, http.MethodPost, "/v0/auth/login", map[string]any{
			"identifier": "alice@example.com", "password": "wrong",
		}, "")
		if status != http.StatusUnauthorized {
			t.Fatalf("wrong password status=%d want=401", status)
		}
		status, headers, body := env.request(client, http.MethodPost, "/v0/auth/login", map[string]any{
			"identifier": "alice@example.com", "password": alicePassword,
		}, "")
		if status != http.StatusOK {
			t.Fatalf("correct password status=%d body=%s", status, body)
		}
		cookie := assertCookieSecurity(t, headers)
		rawToken, err := hex.DecodeString(cookie.Value)
		if err != nil {
			t.Fatal(err)
		}
		var plaintextTokenRows int
		if err := env.pool.QueryRow(context.Background(), "select count(*) from auth_sessions where token_hash=$1", rawToken).Scan(&plaintextTokenRows); err != nil {
			t.Fatal(err)
		}
		if plaintextTokenRows != 0 {
			t.Fatal("session token is stored in plaintext")
		}
	})

	alice := env.login("alice", alicePassword)
	// The deployment has one Human; a second session of the same Account stands
	// for another device or browser of that Human.
	aliceOtherDevice := env.login("alice", alicePassword)

	t.Run("account resolves to the current tenant human actor", func(t *testing.T) {
		status, _, body := env.request(alice, http.MethodGet, "/v0/me", nil, "")
		if status != http.StatusOK {
			t.Fatalf("me status=%d body=%s", status, body)
		}
		var me struct {
			Account struct {
				Email string `json:"email"`
			} `json:"account"`
			Actors []struct {
				ID, TenantID, Kind string
			} `json:"actors"`
		}
		decode(t, body, &me)
		if me.Account.Email != "alice@example.com" || len(me.Actors) != 1 || me.Actors[0].ID != "actor_acme_alice" {
			t.Fatalf("unexpected identity: %+v", me)
		}
		if status, _, body := env.request(alice, http.MethodGet, "/v0/session", nil, ""); status != http.StatusOK {
			t.Fatalf("session status=%d body=%s", status, body)
		}
	})

	roomPayload := map[string]any{"name": "Core room", "description": "shared"}
	roomStatus, _, roomBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/rooms", roomPayload, "")
	if roomStatus != http.StatusCreated {
		t.Fatalf("create room fixture status=%d body=%s", roomStatus, roomBody)
	}
	var room struct {
		ID string `json:"id"`
	}
	decode(t, roomBody, &room)
	if room.ID == "" {
		t.Fatal("create room fixture returned an empty id")
	}
	roomID := room.ID

	t.Run("a repeated room creation finds its name taken and the Room is visible to every session of the Human", func(t *testing.T) {
		status, _, repeatBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/rooms", roomPayload, "")
		if status != http.StatusConflict || !strings.Contains(string(repeatBody), "ROOM_NAME_TAKEN") {
			t.Fatalf("repeated creation status=%d body=%s", status, repeatBody)
		}
		for name, client := range map[string]*http.Client{"first device": alice, "second device": aliceOtherDevice} {
			status, _, responseBody := env.request(client, http.MethodGet, "/v0/rooms/"+roomID, nil, "")
			if status != http.StatusOK {
				t.Fatalf("%s cannot access member Room: status=%d body=%s", name, status, responseBody)
			}
		}
	})

	messagePayload := humanTextMessage("hello from alice")
	messageStatus, _, messageBody := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", messagePayload, idempotencyKey("message-key-0001"))
	if messageStatus != http.StatusCreated {
		t.Fatalf("create message fixture status=%d body=%s", messageStatus, messageBody)
	}
	var message struct {
		ID         string `json:"id"`
		RawMessage string `json:"raw_message"`
		Segments   []struct {
			Type    string `json:"type"`
			Content string `json:"content"`
		} `json:"segments"`
		Author struct {
			ID string `json:"id"`
		} `json:"author"`
	}
	decode(t, messageBody, &message)
	if message.ID == "" {
		t.Fatal("create message fixture returned an empty id")
	}
	if message.RawMessage != "hello from alice" || len(message.Segments) != 1 || message.Segments[0].Type != "text" || message.Segments[0].Content != message.RawMessage {
		t.Fatalf("text message was not normalized: %+v", message)
	}
	messageID := message.ID

	t.Run("message author is session-derived and writes one event", func(t *testing.T) {
		status, _, _ := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
			"raw_message": "forged", "segments": []map[string]any{{"type": "text", "content": "forged"}}, "author_id": "actor_acme_official",
		}, "message-key-forged")
		if status != http.StatusBadRequest {
			t.Fatalf("forged author field status=%d want=400", status)
		}
		if message.Author.ID != "actor_acme_alice" {
			t.Fatalf("author=%q want actor_acme_alice", message.Author.ID)
		}
		status, headers, replayBody := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", messagePayload, idempotencyKey("message-key-0001"))
		if status != http.StatusCreated || string(replayBody) != string(messageBody) || headers.Get("Idempotent-Replay") != "true" {
			t.Fatalf("message replay status=%d header=%q body=%s", status, headers.Get("Idempotent-Replay"), replayBody)
		}
		var messageCount, eventCount int
		if err := env.pool.QueryRow(context.Background(), "select count(*) from messages where id=$1", messageID).Scan(&messageCount); err != nil {
			t.Fatal(err)
		}
		if err := env.pool.QueryRow(context.Background(), "select count(*) from room_events where resource_id=$1 and event_type='message.created'", messageID).Scan(&eventCount); err != nil {
			t.Fatal(err)
		}
		if messageCount != 1 || eventCount != 1 {
			t.Fatalf("message_count=%d event_count=%d", messageCount, eventCount)
		}
	})

	t.Run("structured message persists segments in resource and event snapshots", func(t *testing.T) {
		upload := uploadMessageAttachment(t, alice, env.server.URL, roomID,
			"message-file-version-0001", "FILE.txt", []byte("message file"))
		payload := map[string]any{
			"raw_message": "@alice please review",
			"segments": []map[string]any{
				{"type": "reference", "content": "@alice", "target": "actor_acme_alice", "target_type": "user"},
				{"type": "text", "content": " please review"},
			},
			"attachment_upload_ids": []string{upload.ID},
		}
		status, _, responseBody := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", payload, "message-key-segments-0001")
		if status != http.StatusCreated {
			t.Fatalf("create structured message status=%d body=%s", status, responseBody)
		}
		var created struct {
			ID          string           `json:"id"`
			RawMessage  string           `json:"raw_message"`
			Segments    []map[string]any `json:"segments"`
			Attachments []struct {
				DocumentID        string `json:"document_id"`
				DocumentVersionID string `json:"document_version_id"`
			} `json:"attachments"`
		}
		decode(t, responseBody, &created)
		if created.RawMessage != "@alice please review\nFILE.txt" ||
			len(created.Segments) != 4 || len(created.Attachments) != 1 {
			t.Fatalf("unexpected structured message: %+v", created)
		}
		documentID := created.Attachments[0].DocumentID
		versionID := created.Attachments[0].DocumentVersionID

		status, _, responseBody = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+created.ID, nil, "")
		if status != http.StatusOK {
			t.Fatalf("get structured message status=%d body=%s", status, responseBody)
		}
		var fetched struct {
			RawMessage string           `json:"raw_message"`
			Segments   []map[string]any `json:"segments"`
		}
		decode(t, responseBody, &fetched)
		if fetched.RawMessage != created.RawMessage || len(fetched.Segments) != 4 ||
			fetched.Segments[3]["document_id"] != documentID ||
			fetched.Segments[3]["document_version_id"] != nil {
			t.Fatalf("structured message was not preserved by GET: %+v", fetched)
		}

		var storedRaw, eventRaw string
		var storedSegments, eventSegments []byte
		if err := env.pool.QueryRow(context.Background(), `
			select message.body,message.segments,
			       event.payload->'message'->>'raw_message',event.payload->'message'->'segments'
			from messages message
			join room_events event on event.resource_id=message.id and event.event_type='message.created'
			where message.id=$1`, created.ID).Scan(&storedRaw, &storedSegments, &eventRaw, &eventSegments); err != nil {
			t.Fatal(err)
		}
		if storedRaw != created.RawMessage || eventRaw != created.RawMessage ||
			!bytes.Contains(storedSegments, []byte(documentID)) || bytes.Contains(storedSegments, []byte(versionID)) ||
			!bytes.Contains(eventSegments, []byte(documentID)) || bytes.Contains(eventSegments, []byte(versionID)) {
			t.Fatalf("stored raw=%q segments=%s event_raw=%q event_segments=%s", storedRaw, storedSegments, eventRaw, eventSegments)
		}
	})

	t.Run("invalid structured messages are rejected", func(t *testing.T) {
		tests := []struct {
			name    string
			payload map[string]any
		}{
			{name: "missing segments", payload: map[string]any{"raw_message": "hello"}},
			{name: "missing raw message", payload: map[string]any{"segments": []map[string]any{{"type": "text", "content": "hello"}}}},
			{name: "content mismatch", payload: map[string]any{"raw_message": "hello", "segments": []map[string]any{{"type": "text", "content": "goodbye"}}}},
			{name: "unknown type", payload: map[string]any{"raw_message": "hello", "segments": []map[string]any{{"type": "image", "content": "hello"}}}},
			{name: "unknown segment field", payload: map[string]any{"raw_message": "hello", "segments": []map[string]any{{"type": "text", "content": "hello", "target": "A1"}}}},
			{name: "retired body alias", payload: map[string]any{"body": "hello", "raw_message": "hello", "segments": []map[string]any{{"type": "text", "content": "hello"}}}},
		}
		for index, test := range tests {
			t.Run(test.name, func(t *testing.T) {
				status, _, responseBody := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", test.payload, fmt.Sprintf("message-invalid-%02d", index))
				if status != http.StatusBadRequest {
					t.Fatalf("status=%d want=400 body=%s", status, responseBody)
				}
			})
		}
	})

	t.Run("message and event roll back together", func(t *testing.T) {
		ctx := context.Background()
		_, err := env.pool.Exec(ctx, `
			create or replace function fail_room_event_insert() returns trigger language plpgsql as $$
			begin raise exception 'injected room event failure'; end $$;
			create trigger fail_room_event before insert on room_events for each row execute function fail_room_event_insert();`)
		if err != nil {
			t.Fatal(err)
		}
		status, _, _ := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", humanTextMessage("must roll back"), "message-key-rollback")
		_, dropErr := env.pool.Exec(ctx, "drop trigger fail_room_event on room_events; drop function fail_room_event_insert()")
		if dropErr != nil {
			t.Fatal(dropErr)
		}
		if status != http.StatusInternalServerError {
			t.Fatalf("injected failure status=%d want=500", status)
		}
		var count int
		if err := env.pool.QueryRow(ctx, "select count(*) from messages where body='must roll back'").Scan(&count); err != nil || count != 0 {
			t.Fatalf("rolled-back message count=%d err=%v", count, err)
		}
	})

	t.Run("room sequences increase independently", func(t *testing.T) {
		secondRoom := env.createRoom(alice, acmeTenant, "Second room", idempotencyKey("room-key-0002"))
		env.createMessage(alice, roomID, "next in first", idempotencyKey("message-key-0002"))
		env.createMessage(alice, secondRoom, "first in second", idempotencyKey("message-key-0003"))
		rows, err := env.pool.Query(context.Background(), "select room_id, room_seq from room_events where room_id=any($1) order by room_id, room_seq", []string{roomID, secondRoom})
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		sequences := map[string][]int64{}
		for rows.Next() {
			var id string
			var seq int64
			if err := rows.Scan(&id, &seq); err != nil {
				t.Fatal(err)
			}
			sequences[id] = append(sequences[id], seq)
		}
		for id, values := range sequences {
			for index, value := range values {
				if value != int64(index+1) {
					t.Fatalf("room %s sequence=%v", id, values)
				}
			}
		}
		if len(sequences[secondRoom]) != 2 || sequences[secondRoom][1] != 2 {
			t.Fatalf("second room sequence=%v", sequences[secondRoom])
		}

		status, _, firstPageBody := env.request(aliceOtherDevice, http.MethodGet, "/v0/rooms/"+roomID+"/messages?limit=1", nil, "")
		if status != http.StatusOK {
			t.Fatalf("first message page status=%d body=%s", status, firstPageBody)
		}
		var firstPage struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
			Page struct {
				HasMore    bool   `json:"has_more"`
				NextCursor string `json:"next_cursor"`
			} `json:"page"`
		}
		decode(t, firstPageBody, &firstPage)
		if len(firstPage.Items) != 1 || !firstPage.Page.HasMore || firstPage.Page.NextCursor == "" {
			t.Fatalf("unexpected first page: %+v", firstPage)
		}
		status, _, secondPageBody := env.request(aliceOtherDevice, http.MethodGet, "/v0/rooms/"+roomID+"/messages?limit=1&cursor="+firstPage.Page.NextCursor, nil, "")
		if status != http.StatusOK {
			t.Fatalf("second message page status=%d body=%s", status, secondPageBody)
		}
		var secondPage struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
		}
		decode(t, secondPageBody, &secondPage)
		if len(secondPage.Items) != 1 || secondPage.Items[0].ID == firstPage.Items[0].ID {
			t.Fatalf("unexpected second page: %+v", secondPage)
		}
	})

	t.Run("expired and revoked sessions cannot access tenant data", func(t *testing.T) {
		expired := env.login("alice", alicePassword)
		cookie := sessionCookie(t, expired, env.server.URL)
		rawToken, err := hex.DecodeString(cookie.Value)
		if err != nil {
			t.Fatal(err)
		}
		tokenHash := sha256.Sum256(rawToken)
		if _, err := env.pool.Exec(context.Background(), "update auth_sessions set created_at=now()-interval '2 hours', expires_at=now()-interval '1 hour' where token_hash=$1", tokenHash[:]); err != nil {
			t.Fatal(err)
		}
		status, _, _ := env.request(expired, http.MethodGet, "/v0/tenants/"+acmeTenant+"/rooms", nil, "")
		if status != http.StatusUnauthorized {
			t.Fatalf("expired session status=%d want=401", status)
		}
		revoked := env.login("alice", alicePassword)
		status, _, _ = env.request(revoked, http.MethodPost, "/v0/auth/logout", nil, "")
		if status != http.StatusNoContent {
			t.Fatalf("logout status=%d", status)
		}
		status, _, _ = env.request(revoked, http.MethodGet, "/v0/tenants/"+acmeTenant+"/rooms", nil, "")
		if status != http.StatusUnauthorized {
			t.Fatalf("revoked session status=%d want=401", status)
		}
	})
}

// login signs in with an email; a bare seed name such as alice stands for
// alice@example.com.
func (e *testEnv) login(identifier, password string) *http.Client {
	e.t.Helper()
	if !strings.Contains(identifier, "@") {
		identifier += "@example.com"
	}
	client := newClient(e.t)
	status, _, body := e.request(client, http.MethodPost, "/v0/auth/login", map[string]any{"identifier": identifier, "password": password}, "")
	if status != http.StatusOK {
		e.t.Fatalf("login %s status=%d body=%s", identifier, status, body)
	}
	return client
}

func (e *testEnv) createRoom(client *http.Client, tenantID, name, key string) string {
	e.t.Helper()
	status, _, body := e.request(client, http.MethodPost, "/v0/tenants/"+tenantID+"/rooms", map[string]any{"name": name}, key)
	if status != http.StatusCreated {
		e.t.Fatalf("create room status=%d body=%s", status, body)
	}
	var response struct {
		ID string `json:"id"`
	}
	decode(e.t, body, &response)
	return response.ID
}

func (e *testEnv) createMessage(client *http.Client, roomID, bodyText, key string) {
	e.t.Helper()
	status, _, body := e.request(client, http.MethodPost, "/v0/rooms/"+roomID+"/messages", humanTextMessage(bodyText), key)
	if status != http.StatusCreated {
		e.t.Fatalf("create message status=%d body=%s", status, body)
	}
}

func (e *testEnv) request(client *http.Client, method, path string, payload any, key string) (int, http.Header, []byte) {
	e.t.Helper()
	var reader io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			e.t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, e.server.URL+path, reader)
	if err != nil {
		e.t.Fatal(err)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	response, err := client.Do(request)
	if err != nil {
		e.t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		e.t.Fatal(err)
	}
	return response.StatusCode, response.Header, body
}

// newClient returns a cookie-carrying client. The timeout bounds a hung request so
// that a failing test does not wait for the go test timeout.
func newClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Jar: jar, Timeout: 60 * time.Second}
}

// registerIntegrationServerCleanup closes client connections before the server, so a
// handler blocked on a request body or gate sees its context cancelled. Close alone
// waits for such handlers, which turns a test failure into a hang.
func registerIntegrationServerCleanup(t *testing.T, server *httptest.Server) {
	t.Helper()
	t.Cleanup(func() {
		server.CloseClientConnections()
		server.Close()
	})
}

func assertCookieSecurity(t *testing.T, headers http.Header) *http.Cookie {
	t.Helper()
	for _, cookie := range (&http.Response{Header: headers}).Cookies() {
		if cookie.Name == "teamhub_session" {
			if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
				t.Fatalf("insecure session cookie: %+v", cookie)
			}
			return cookie
		}
	}
	t.Fatal("teamhub_session Set-Cookie not found")
	return nil
}

func sessionCookie(t *testing.T, client *http.Client, serverURL string) *http.Cookie {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, serverURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, cookie := range client.Jar.Cookies(request.URL) {
		if cookie.Name == "teamhub_session" {
			return cookie
		}
	}
	t.Fatal("teamhub_session cookie not found")
	return nil
}

func decode(t *testing.T, body []byte, target any) {
	t.Helper()
	if err := json.Unmarshal(body, target); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
}
