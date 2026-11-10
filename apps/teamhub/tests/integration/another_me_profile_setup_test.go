package integration_test

import (
	"crypto/sha256"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const (
	profileSetupGreeting      = "Hi alice, I'm your Another Me — think of me as another you in Linger."
	profileSetupAppsPrompt    = "Before I help with replies and follow-ups, I'd like to get to know you. The quickest way is to let me see where you talk about work — one account is enough."
	profileSetupSourcesPrompt = "Do you have a personal website or portfolio? Paste a link, or upload your resume and work samples."
)

type profileSetupFixture struct {
	env     *testEnv
	pool    *pgxpool.Pool
	human   *http.Client
	roomID  string
	agentID string
}

// newProfileSetupFixture connects the Human's Computer, which creates their
// AnotherMe with its template opening, and returns its Direct Room. configure
// adjusts the TeamHub configuration further.
func newProfileSetupFixture(t *testing.T, configure ...func(*config.Config)) profileSetupFixture {
	t.Helper()
	env, pool := newConnectedAnotherMeEnv(t, func(cfg *config.Config) {
		cfg.ArtifactMaxBytes = 1 << 20
		for _, apply := range configure {
			apply(cfg)
		}
	})
	return profileSetupFixture{
		env: env, pool: pool, human: env.login("alice", alicePassword),
		roomID:  anotherMeRoomID(t, pool, "actor_acme_alice"),
		agentID: anotherMeActorID(t, env, acmeTenant, "actor_acme_alice"),
	}
}

// card returns the setup decision of one kind: its ID, Message and current
// version.
func (f profileSetupFixture) card(t *testing.T, kind string) (decisionID, messageID string, version int64) {
	t.Helper()
	if err := f.pool.QueryRow(t.Context(), `
		SELECT decision.id,decision.message_id,card.version
		FROM decisions decision JOIN message_cards card ON card.message_id=decision.message_id
		WHERE decision.room_id=$1 AND decision.kind=$2
	`, f.roomID, kind).Scan(&decisionID, &messageID, &version); err != nil {
		t.Fatalf("read %s card: %v", kind, err)
	}
	return decisionID, messageID, version
}

// decide answers a decision; answer holds the decision and its fields.
func (f profileSetupFixture) decide(client *http.Client, decisionID string, version int64, answer map[string]any, key string) (int, []byte) {
	request := map[string]any{"expected_version": version}
	for name, value := range answer {
		request[name] = value
	}
	status, _, body := f.env.request(client, http.MethodPost, "/v0/decisions/"+decisionID, request, key)
	return status, body
}

// disposition is how AnotherMe's Inbox treats one Message: notify wakes it.
func (f profileSetupFixture) disposition(t *testing.T, messageID string) string {
	t.Helper()
	var value string
	if err := f.pool.QueryRow(t.Context(), `
		SELECT disposition FROM agent_inbox_message_disposition($1,$2,NULL,NULL,$3)
	`, acmeTenant, f.agentID, messageID).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func (f profileSetupFixture) messageID(t *testing.T, body string) string {
	t.Helper()
	var id string
	if err := f.pool.QueryRow(t.Context(), `SELECT id FROM messages WHERE room_id=$1 AND body=$2`, f.roomID, body).Scan(&id); err != nil {
		t.Fatalf("read Message %q: %v", body, err)
	}
	return id
}

// listedBodies is the Room's Message texts in the order the Human's message list
// returns them.
func (f profileSetupFixture) listedBodies(t *testing.T) []string {
	t.Helper()
	status, _, body := f.env.request(f.human, http.MethodGet, "/v0/rooms/"+f.roomID+"/messages?limit=50", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list messages status=%d body=%s", status, body)
	}
	var page httpapi.MessagePage
	decode(t, body, &page)
	bodies := make([]string, 0, len(page.Items))
	for _, message := range page.Items {
		bodies = append(bodies, message.RawMessage)
	}
	return bodies
}

// rowCounts is every row a setup decision could write.
func (f profileSetupFixture) rowCounts(t *testing.T) [4]int {
	t.Helper()
	return [4]int{
		countRows(t, f.env, `SELECT count(*) FROM messages WHERE room_id=$1`, f.roomID),
		countRows(t, f.env, `SELECT count(*) FROM decisions WHERE room_id=$1 AND status<>'pending'`, f.roomID),
		countRows(t, f.env, `SELECT count(*) FROM decisions WHERE room_id=$1`, f.roomID),
		countRows(t, f.env, `SELECT count(*) FROM document_context_bindings WHERE room_id=$1 AND binding_kind='room'`, f.roomID),
	}
}

func (f profileSetupFixture) upload(t *testing.T, key, filename string) string {
	t.Helper()
	return uploadMessageAttachment(t, f.human, f.env.server.URL, f.roomID, key, filename, []byte("content of "+filename)).ID
}

// decideApps takes the apps card to the sources card.
func (f profileSetupFixture) decideApps(t *testing.T, decision string) {
	t.Helper()
	decisionID, _, version := f.card(t, typedcard.DecisionKindProfileSetupApps)
	if status, body := f.decide(f.human, decisionID, version, map[string]any{"decision": decision}, "profile-apps-"+decision); status != http.StatusOK {
		t.Fatalf("apps decision status=%d body=%s", status, body)
	}
}

// onboardingStatusMessage is a hidden onboarding status AnotherMe reads.
type onboardingStatusMessage struct{ id, body string }

// onboardingStatus returns the one hidden status, written in the Human's name
// for the setup card cardMessageID, that mentions AnotherMe.
func (f profileSetupFixture) onboardingStatus(t *testing.T, cardMessageID string) onboardingStatusMessage {
	t.Helper()
	var status onboardingStatusMessage
	if err := f.pool.QueryRow(t.Context(), `
		SELECT id,body FROM messages
		WHERE room_id=$1 AND message_kind='agent_runtime' AND author_actor_id='actor_acme_alice'
		  AND card_context_message_id=$2 AND mentioned_actor_ids=ARRAY[$3]::text[]
	`, f.roomID, cardMessageID, f.agentID).Scan(&status.id, &status.body); err != nil {
		t.Fatalf("read onboarding status of %s: %v", cardMessageID, err)
	}
	return status
}

// say posts the Human's own Message and returns its ID.
func (f profileSetupFixture) say(t *testing.T, text, key string) string {
	t.Helper()
	status, _, body := f.env.request(f.human, http.MethodPost, "/v0/rooms/"+f.roomID+"/messages", map[string]any{
		"raw_message": text, "segments": []map[string]any{{"type": "text", "content": text}},
	}, key)
	if status != http.StatusCreated {
		t.Fatalf("post %q status=%d body=%s", text, status, body)
	}
	return f.messageID(t, text)
}

// grantGmail connects Alice's Gmail and grants it to her AnotherMe.
func (f profileSetupFixture) grantGmail(t *testing.T) {
	t.Helper()
	if _, err := f.pool.Exec(t.Context(), `
		INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,identity_label,toolkit_slug)
		SELECT 'connection_onboarding_gmail',account_id,'gmail','upstream_onboarding_gmail','active','alice@example.test','gmail'
		FROM actors WHERE id='actor_acme_alice'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `
		INSERT INTO external_connection_agent_grants(id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status)
		VALUES('grant_onboarding_gmail','connection_onboarding_gmail',$1,$2,'actor_acme_alice','active')`,
		acmeTenant, f.agentID); err != nil {
		t.Fatal(err)
	}
}

func TestAnotherMeOpeningTemplatePostsGreetingAndAppsCard(t *testing.T) {
	allowParallelIntegrationTest(t)
	f := newProfileSetupFixture(t)
	var bodies []string
	rows, err := f.pool.Query(t.Context(), `
		SELECT message.body FROM messages message JOIN room_events event ON event.resource_id=message.id AND event.room_id=message.room_id
		WHERE message.room_id=$1 AND event.event_type='message.created' ORDER BY event.room_seq`, f.roomID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			t.Fatal(err)
		}
		bodies = append(bodies, body)
	}
	if rows.Err() != nil || len(bodies) != 2 || bodies[0] != profileSetupGreeting || bodies[1] != profileSetupAppsPrompt {
		t.Fatalf("opening Messages=%q err=%v", bodies, rows.Err())
	}
	// Both Messages share one transaction; the list keeps their write order.
	if listed := f.listedBodies(t); len(listed) != 2 || listed[0] != profileSetupGreeting || listed[1] != profileSetupAppsPrompt {
		t.Fatalf("listed opening Messages=%q", listed)
	}
	var decider, requester, view, status string
	var expires bool
	if err := f.pool.QueryRow(t.Context(), `
		SELECT decider_actor_id,requested_by_actor_id,view::text,status,expires_at IS NOT NULL FROM decisions WHERE room_id=$1
	`, f.roomID).Scan(&decider, &requester, &view, &status, &expires); err != nil {
		t.Fatal(err)
	}
	if decider != "actor_acme_alice" || requester != f.agentID || status != "pending" || expires ||
		!strings.Contains(view, `"apps": ["gmail", "outlook", "google_calendar"]`) || !strings.Contains(view, `"more_apps": ["github", "notion"]`) {
		t.Fatalf("apps card decider=%s requester=%s status=%s view=%s", decider, requester, status, view)
	}
	if got := countRows(t, f.env, `SELECT count(*) FROM messages WHERE room_id=$1 AND mentioned_actor_ids<>'{}'`, f.roomID); got != 0 {
		t.Fatalf("opening mentions=%d", got)
	}
}

func TestAnotherMeProfileSetupAppsDecisionRecordsWithoutWakingAndAsksForSources(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, decision := range []string{"connected", "skipped"} {
		t.Run(decision, func(t *testing.T) {
			f := newProfileSetupFixture(t)
			decisionID, cardMessageID, version := f.card(t, typedcard.DecisionKindProfileSetupApps)
			if status, body := f.decide(f.human, decisionID, version, map[string]any{"decision": "done"}, "profile-apps-invalid"); status != http.StatusBadRequest {
				t.Fatalf("invalid decision status=%d body=%s", status, body)
			}
			payload := map[string]any{"decision": decision}
			status, first := f.decide(f.human, decisionID, version, payload, "profile-apps-"+decision)
			if status != http.StatusOK {
				t.Fatalf("decision status=%d body=%s", status, first)
			}
			resultText, reply := "Connected", "Got it."
			if decision == "skipped" {
				resultText, reply = "Skip for now", "No problem."
			}
			result := f.messageID(t, resultText)
			if got := countRows(t, f.env, `SELECT count(*) FROM messages WHERE id=$1 AND author_actor_id='actor_acme_alice' AND message_kind='conversation' AND card_context_message_id=$2`, result, cardMessageID); got != 1 {
				t.Fatalf("visible result rows=%d", got)
			}
			if got := f.disposition(t, result); got != "skip" {
				t.Fatalf("result disposition=%s want skip", got)
			}
			if got := countRows(t, f.env, `SELECT count(*) FROM messages WHERE room_id=$1 AND message_kind='agent_runtime'`, f.roomID); got != 0 {
				t.Fatalf("handoff Messages=%d", got)
			}
			if got := countRows(t, f.env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id=$2 AND body=$3`, f.roomID, f.agentID, reply); got != 1 {
				t.Fatalf("acknowledgement rows=%d", got)
			}
			sourcesID, sourcesMessageID, _ := f.card(t, typedcard.DecisionKindProfileSetupSources)
			var assignee, prompt, body string
			if err := f.pool.QueryRow(t.Context(), `
				SELECT decision.decider_actor_id,decision.view->>'prompt',message.body FROM decisions decision
				JOIN messages message ON message.id=decision.message_id WHERE decision.id=$1
			`, sourcesID).Scan(&assignee, &prompt, &body); err != nil {
				t.Fatal(err)
			}
			if assignee != "actor_acme_alice" || prompt != profileSetupSourcesPrompt || body != profileSetupSourcesPrompt || sourcesMessageID == "" {
				t.Fatalf("sources card assignee=%s prompt=%q body=%q", assignee, prompt, body)
			}
			// The three decision Messages share one transaction; the list keeps their write order.
			if listed := f.listedBodies(t); len(listed) != 5 || listed[2] != resultText || listed[3] != reply || listed[4] != profileSetupSourcesPrompt {
				t.Fatalf("listed decision Messages=%q", listed)
			}
			var resolved string
			if err := f.pool.QueryRow(t.Context(), `SELECT status FROM decisions WHERE id=$1`, decisionID).Scan(&resolved); err != nil || resolved != "answered" {
				t.Fatalf("apps card status=%s err=%v", resolved, err)
			}

			// Decisions carry no key: a repeat, even with the first key, is a stale version.
			before := f.rowCounts(t)
			if status, body := f.decide(f.human, decisionID, version, payload, "profile-apps-"+decision); status != http.StatusConflict {
				t.Fatalf("repeated decision status=%d body=%s", status, body)
			}
			if after := f.rowCounts(t); after != before {
				t.Fatalf("repeated decision rows before=%v after=%v", before, after)
			}
		})
	}
}

func TestAnotherMeProfileSetupSourcesDoneHandsOffStatusWithAttachments(t *testing.T) {
	allowParallelIntegrationTest(t)
	f := newProfileSetupFixture(t)
	f.decideApps(t, "skipped")
	decisionID, cardMessageID, version := f.card(t, typedcard.DecisionKindProfileSetupSources)
	uploads := []string{f.upload(t, "profile-upload-resume", "resume.txt"), f.upload(t, "profile-upload-sample", "sample.txt")}
	payload := map[string]any{
		"decision":              "done",
		"links":                 []string{" https://alice.example.com ", "https://github.com/alice", "https://alice.example.com"},
		"attachment_upload_ids": uploads,
	}
	// Two concurrent decisions: one wins, the other sees a stale version.
	var wg sync.WaitGroup
	statuses := make([]int, 2)
	bodies := make([][]byte, 2)
	for index := range statuses {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			statuses[index], bodies[index] = f.decide(f.human, decisionID, version, payload, "profile-sources-"+string(rune('a'+index)))
		}(index)
	}
	wg.Wait()
	winner := 0
	if statuses[0] != http.StatusOK {
		winner = 1
	}
	if statuses[winner] != http.StatusOK || statuses[1-winner] != http.StatusConflict {
		t.Fatalf("concurrent decisions statuses=%v bodies=%s / %s", statuses, bodies[0], bodies[1])
	}
	if got := f.disposition(t, f.messageID(t, "That's all")); got != "skip" {
		t.Fatalf("result disposition=%s want skip", got)
	}
	// The Human never wrote, so the status tells AnotherMe to start.
	status := f.onboardingStatus(t, cardMessageID)
	for _, want := range []string{"Setup cards: finished.", "Connected apps: none.",
		"Links: https://alice.example.com https://github.com/alice", "Files: 2, attached to this message.",
		"Tell the Human you are starting their profile"} {
		if !strings.Contains(status.body, want) {
			t.Fatalf("status lacks %q: %s", want, status.body)
		}
	}
	if got := countRows(t, f.env, `SELECT jsonb_array_length(attachments) FROM messages WHERE id=$1`, status.id); got != 2 {
		t.Fatalf("status attachments=%d", got)
	}
	objectKeys := []string{attachmentUploadObjectKey(t, uploads[0]), attachmentUploadObjectKey(t, uploads[1])}
	if got := countRows(t, f.env, `SELECT count(*) FROM document_versions WHERE content_object_id=ANY($1)`, objectKeys); got != 2 {
		t.Fatalf("attached uploads=%d", got)
	}
	if got := f.disposition(t, status.id); got != "notify" {
		t.Fatalf("status disposition=%s want notify", got)
	}
	// Nothing speaks for the Human.
	if got := countRows(t, f.env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_alice' AND message_kind='conversation' AND card_context_message_id IS NULL`, f.roomID); got != 0 {
		t.Fatalf("Human-authored conversation Messages=%d", got)
	}
	before := f.rowCounts(t)
	key := "profile-sources-" + string(rune('a'+winner))
	if status, body := f.decide(f.human, decisionID, version, payload, key); status != http.StatusConflict {
		t.Fatalf("repeated decision status=%d body=%s", status, body)
	}
	if after := f.rowCounts(t); after != before {
		t.Fatalf("repeated decision rows before=%v after=%v", before, after)
	}
}

func TestAnotherMeProfileSetupSourcesRejectsInvalidInputWithoutWriting(t *testing.T) {
	allowParallelIntegrationTest(t)
	f := newProfileSetupFixture(t)
	f.decideApps(t, "connected")
	decisionID, _, version := f.card(t, typedcard.DecisionKindProfileSetupSources)
	consumed := f.upload(t, "profile-upload-consumed", "consumed.txt")
	if status, _, body := f.env.request(f.human, http.MethodPost, "/v0/rooms/"+f.roomID+"/messages", map[string]any{
		"raw_message": "first", "segments": []map[string]any{{"type": "text", "content": "first"}},
		"attachment_upload_ids": []string{consumed},
	}, "profile-consume-first"); status != http.StatusCreated {
		t.Fatalf("consume upload status=%d body=%s", status, body)
	}
	cancelled := f.upload(t, "profile-upload-cancelled", "cancelled.txt")
	if status, _, body := f.env.request(f.human, http.MethodDelete, "/v0/rooms/"+f.roomID+"/message-attachment-uploads/"+cancelled, nil, ""); status != http.StatusNoContent {
		t.Fatalf("cancel upload status=%d body=%s", status, body)
	}
	otherRoom := f.env.createRoom(f.human, acmeTenant, "Other uploads", "profile-other-room")
	foreign := uploadMessageAttachment(t, f.human, f.env.server.URL, otherRoom, "profile-upload-foreign", "foreign.txt", []byte("foreign")).ID
	six := make([]string, 6)
	sixLinks := make([]string, 6)
	for index := range six {
		six[index] = f.upload(t, "profile-upload-six-"+string(rune('a'+index)), "six.txt")
		sixLinks[index] = "https://example.com/" + string(rune('a'+index))
	}
	cases := []struct {
		name    string
		payload map[string]any
		status  int
	}{
		{"relative link", map[string]any{"decision": "done", "links": []string{"alice.example.com"}}, http.StatusBadRequest},
		{"ftp link", map[string]any{"decision": "done", "links": []string{"ftp://alice.example.com"}}, http.StatusBadRequest},
		{"long link", map[string]any{"decision": "done", "links": []string{"https://example.com/" + strings.Repeat("a", 2048)}}, http.StatusBadRequest},
		{"six links", map[string]any{"decision": "done", "links": sixLinks}, http.StatusBadRequest},
		{"six uploads", map[string]any{"decision": "done", "attachment_upload_ids": six}, http.StatusBadRequest},
		{"skipped with links", map[string]any{"decision": "skipped", "links": []string{"https://alice.example.com"}}, http.StatusBadRequest},
		{"skipped with uploads", map[string]any{"decision": "skipped", "attachment_upload_ids": six[:1]}, http.StatusBadRequest},
		{"consumed upload", map[string]any{"decision": "done", "attachment_upload_ids": []string{consumed}}, http.StatusConflict},
		{"cancelled upload", map[string]any{"decision": "done", "attachment_upload_ids": []string{cancelled}}, http.StatusConflict},
		{"foreign upload", map[string]any{"decision": "done", "attachment_upload_ids": []string{foreign}}, http.StatusConflict},
		{"missing upload", map[string]any{"decision": "done", "attachment_upload_ids": []string{"eyJvIjoibWlzc2luZyJ9.bm90LXNpZ25lZA"}}, http.StatusConflict},
	}
	before := f.rowCounts(t)
	for index, item := range cases {
		status, body := f.decide(f.human, decisionID, version, item.payload, "profile-invalid-"+string(rune('a'+index)))
		if status != item.status || item.status == http.StatusConflict && !strings.Contains(string(body), "ATTACHMENT_UPLOAD_UNAVAILABLE") {
			t.Fatalf("%s status=%d body=%s", item.name, status, body)
		}
	}
	if after := f.rowCounts(t); after != before {
		t.Fatalf("invalid decisions wrote rows before=%v after=%v", before, after)
	}
}

func TestAnotherMeProfileSetupFinishedWithoutSourcesTellsAnotherMeToChat(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, appsDecision := range []string{"connected", "skipped"} {
		for _, sourceDecision := range []string{"done", "skipped"} {
			t.Run(appsDecision+"/"+sourceDecision, func(t *testing.T) {
				f := newProfileSetupFixture(t)
				f.decideApps(t, appsDecision)
				decisionID, cardMessageID, version := f.card(t, typedcard.DecisionKindProfileSetupSources)
				payload := map[string]any{"decision": sourceDecision}
				key := "profile-sources-empty"
				status, body := f.decide(f.human, decisionID, version, payload, key)
				if status != http.StatusOK {
					t.Fatalf("decision status=%d body=%s", status, body)
				}
				resultText := "That's all"
				if sourceDecision == "skipped" {
					resultText = "Skip"
				}
				if got := f.disposition(t, f.messageID(t, resultText)); got != "skip" {
					t.Fatalf("result disposition=%s want skip", got)
				}
				onboarding := f.onboardingStatus(t, cardMessageID)
				if !strings.Contains(onboarding.body, "The Human shared nothing. Do not open the personal-profile Skill") {
					t.Fatalf("status=%s", onboarding.body)
				}
				if got := f.disposition(t, onboarding.id); got != "notify" {
					t.Fatalf("status disposition=%s want notify", got)
				}
				before := f.rowCounts(t)
				if repeatStatus, repeat := f.decide(f.human, decisionID, version, payload, key); repeatStatus != http.StatusConflict {
					t.Fatalf("repeated decision status=%d body=%s", repeatStatus, repeat)
				}
				if after := f.rowCounts(t); after != before {
					t.Fatalf("repeated decision wrote rows before=%v after=%v", before, after)
				}
			})
		}
	}
}

// The Human's first own Message while setup is open carries the status just
// ahead of it, once; later Messages do not. Finishing setup afterwards asks
// before starting, since the Human is mid-conversation.
func TestAnotherMeOnboardingStatusPrecedesTheHumansFirstMessage(t *testing.T) {
	allowParallelIntegrationTest(t)
	// Connected Apps list a grant only while Composio is configured.
	f := newProfileSetupFixture(t, newFakeComposio(t).configure)
	_, appsMessageID, _ := f.card(t, typedcard.DecisionKindProfileSetupApps)
	f.grantGmail(t)
	first := f.say(t, "hello", "onboarding-first")
	progress := f.onboardingStatus(t, appsMessageID)
	for _, want := range []string{"Setup cards: not finished", "- Gmail alice@example.test, connection connection_onboarding_gmail",
		"ask whether to start now from what is connected so far"} {
		if !strings.Contains(progress.body, want) {
			t.Fatalf("progress status lacks %q: %s", want, progress.body)
		}
	}
	var statusSeq, firstSeq int64
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT room_seq FROM messages WHERE id=$1),(SELECT room_seq FROM messages WHERE id=$2)`,
		progress.id, first).Scan(&statusSeq, &firstSeq); err != nil {
		t.Fatal(err)
	}
	if statusSeq+1 != firstSeq {
		t.Fatalf("status seq=%d first Message seq=%d", statusSeq, firstSeq)
	}
	if f.disposition(t, progress.id) != "notify" || f.disposition(t, first) != "notify" {
		t.Fatal("status and first Message both reach AnotherMe")
	}
	f.say(t, "again", "onboarding-second")
	if got := countRows(t, f.env, `SELECT count(*) FROM messages WHERE room_id=$1 AND message_kind='agent_runtime'`, f.roomID); got != 1 {
		t.Fatalf("statuses after a second Message=%d", got)
	}

	f.decideApps(t, "connected")
	decisionID, sourcesMessageID, version := f.card(t, typedcard.DecisionKindProfileSetupSources)
	if status, body := f.decide(f.human, decisionID, version, map[string]any{"decision": "skipped"}, "onboarding-sources"); status != http.StatusOK {
		t.Fatalf("sources decision status=%d body=%s", status, body)
	}
	finished := f.onboardingStatus(t, sourcesMessageID)
	if !strings.Contains(finished.body, "Setup cards: finished.") || !strings.Contains(finished.body, "ask the Human once whether to start now") {
		t.Fatalf("finished status=%s", finished.body)
	}
}

// Once setup is finished, the Human's Messages carry no status.
func TestAnotherMeOnboardingStatusOnlyWhileSetupIsOpen(t *testing.T) {
	allowParallelIntegrationTest(t)
	f := newProfileSetupFixture(t)
	f.decideApps(t, "skipped")
	decisionID, _, version := f.card(t, typedcard.DecisionKindProfileSetupSources)
	if status, body := f.decide(f.human, decisionID, version, map[string]any{"decision": "skipped"}, "onboarding-closed"); status != http.StatusOK {
		t.Fatalf("sources decision status=%d body=%s", status, body)
	}
	before := countRows(t, f.env, `SELECT count(*) FROM messages WHERE room_id=$1 AND message_kind='agent_runtime'`, f.roomID)
	f.say(t, "hello", "onboarding-after-setup")
	if got := countRows(t, f.env, `SELECT count(*) FROM messages WHERE room_id=$1 AND message_kind='agent_runtime'`, f.roomID); got != before {
		t.Fatalf("statuses before=%d after=%d", before, got)
	}
}

// An existing card in AnotherMe's Direct Room wakes it once, through the
// hidden handoff; the visible result no longer wakes it a second time. An
// ordinary Human message still wakes it.
func TestAnotherMeDecisionResultsWakeOnlyThroughHandoff(t *testing.T) {
	allowParallelIntegrationTest(t)
	f := newProfileSetupFixture(t)
	var managementID string
	if err := f.pool.QueryRow(t.Context(), `SELECT agent_management_id FROM agent_registrations WHERE actor_id=$1`, f.agentID).Scan(&managementID); err != nil {
		t.Fatal(err)
	}
	key := "another-me-question-card"
	hash := sha256.Sum256([]byte(key))
	created, err := typedcard.New(f.pool).CreateDecision(t.Context(), f.roomID, managementID, key, hash[:], typedcard.DecisionCommand{
		DeciderActorID: "actor_acme_alice",
		Question:       &typedcard.QuestionDecision{Prompt: "Which day works?", Questions: []typedcard.DecisionQuestion{{ID: "day", Prompt: "Day", Input: "radio", Options: []typedcard.DecisionQuestionOption{{ID: "fri", Label: "Friday"}}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	before := countRows(t, f.env, `SELECT count(*) FROM room_events WHERE room_id=$1`, f.roomID)
	if status, body := f.decide(f.human, created.DecisionID, 1, map[string]any{"decision": "submit", "answers": map[string]any{"day": "Monday"}}, "another-me-question-decision"); status != http.StatusOK {
		t.Fatalf("question decision status=%d body=%s", status, body)
	}
	rows, err := f.pool.Query(t.Context(), `
		SELECT message.id FROM messages message JOIN room_events event ON event.resource_id=message.id AND event.room_id=message.room_id
		WHERE message.room_id=$1 AND event.event_type='message.created' AND event.room_seq>$2`, f.roomID, before)
	if err != nil {
		t.Fatal(err)
	}
	var decided []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		decided = append(decided, id)
	}
	if rows.Err() != nil || len(decided) == 0 {
		t.Fatalf("decision Messages=%v err=%v", decided, rows.Err())
	}
	wakes := 0
	for _, id := range decided {
		if f.disposition(t, id) == "notify" {
			wakes++
		}
	}
	if wakes != 1 {
		t.Fatalf("question decision wakes=%d want 1 (messages=%v)", wakes, decided)
	}
	if got := countRows(t, f.env, `SELECT count(*) FROM messages WHERE id=ANY($1) AND message_kind='agent_runtime'`, decided); got != 1 {
		t.Fatalf("handoff Messages=%d", got)
	}
	status, _, body := f.env.request(f.human, http.MethodPost, "/v0/rooms/"+f.roomID+"/messages", map[string]any{
		"raw_message": "hello", "segments": []map[string]any{{"type": "text", "content": "hello"}},
	}, "another-me-ordinary-message")
	if status != http.StatusCreated {
		t.Fatalf("ordinary Message status=%d body=%s", status, body)
	}
	if got := f.disposition(t, f.messageID(t, "hello")); got != "notify" {
		t.Fatalf("ordinary Message disposition=%s want notify", got)
	}
}
