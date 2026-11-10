package integration_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

func TestRoomMessageCardHydrationQueryCountIsConstantAtLimit200(t *testing.T) {
	allowParallelIntegrationTest(t)
	tracer := &queryCountTracer{}
	env, alice := newRoomMessageQueryCountEnv(t, tracer)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Card query count "+suffix, "card-query-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	seedQueryCountCards(t, env, roomID, suffix, 200)

	smallCount := listCardPageWithQueryCount(t, tracer, env, alice, roomID, 3, 3)
	largeCount := listCardPageWithQueryCount(t, tracer, env, alice, roomID, 200, 200)
	t.Logf("Room Message hydration query count: limit=3 queries=%d limit=200 queries=%d", smallCount, largeCount)
	if largeCount > smallCount+2 {
		t.Fatalf("Room Message hydration queries grew with card count: limit=3 queries=%d limit=200 queries=%d", smallCount, largeCount)
	}
}

type queryCountTracer struct {
	mu      sync.Mutex
	enabled bool
	count   int
}

type queryCountRequestContextKey struct{}

func (tracer *queryCountTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	tracer.mu.Lock()
	defer tracer.mu.Unlock()
	if tracer.enabled && ctx.Value(queryCountRequestContextKey{}) != nil {
		tracer.count++
	}
	return ctx
}

func (*queryCountTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (tracer *queryCountTracer) measure(run func()) int {
	tracer.mu.Lock()
	tracer.count = 0
	tracer.enabled = true
	tracer.mu.Unlock()
	run()
	tracer.mu.Lock()
	defer tracer.mu.Unlock()
	tracer.enabled = false
	return tracer.count
}

func newRoomMessageQueryCountEnv(t *testing.T, tracer pgx.QueryTracer) (*testEnv, *http.Client) {
	t.Helper()
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	parsedDatabaseURL, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	databaseQuery := parsedDatabaseURL.Query()
	databaseQuery.Set("statement_timeout", "2s")
	parsedDatabaseURL.RawQuery = databaseQuery.Encode()
	databaseURL = parsedDatabaseURL.String()
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	application, err := newIntegrationApp(t.Context(), config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
	}), withQueryTracer(tracer))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	handler := application.Handler()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestContext := context.WithValue(request.Context(), queryCountRequestContextKey{}, struct{}{})
		handler.ServeHTTP(response, request.WithContext(requestContext))
	}))
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	return env, env.login("alice", alicePassword)
}

// seedQueryCountCards commits count pending create_room approval cards through
// the live creation approval writer.
func seedQueryCountCards(t *testing.T, env *testEnv, roomID, suffix string, count int) {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	cards := typedcard.New(env.pool)
	for index := range count {
		if _, err := cards.CreateCreationApprovalRequestInTx(t.Context(), tx, roomCreationApprovalInput(t, roomID, fmt.Sprintf("query-count-%s-%d", suffix, index))); err != nil {
			t.Fatalf("seed query-count card %d: %v", index, err)
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func listCardPageWithQueryCount(
	t *testing.T,
	tracer *queryCountTracer,
	env *testEnv,
	client *http.Client,
	roomID string,
	limit int,
	wantItems int,
) int {
	t.Helper()
	var status int
	var body []byte
	count := tracer.measure(func() {
		status, _, body = env.request(client, http.MethodGet,
			"/v0/rooms/"+roomID+"/messages?limit="+strconv.Itoa(limit), nil, "")
	})
	if status != http.StatusOK {
		t.Fatalf("list card page limit=%d status=%d body=%s", limit, status, body)
	}
	var page struct {
		Items []cardMessageResponse `json:"items"`
	}
	decode(t, body, &page)
	if len(page.Items) != wantItems {
		t.Fatalf("list card page limit=%d items=%d want=%d", limit, len(page.Items), wantItems)
	}
	for _, item := range page.Items {
		if item.Card.Intent == "" || item.Card.DecisionID == "" {
			t.Fatalf("list card page returned an unhydrated Message: %+v", item)
		}
	}
	return count
}
