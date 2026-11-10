package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentmessages"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type historyQueryRecorder struct {
	store.DBTX
	statement string
	args      []any
}

func (r *historyQueryRecorder) Query(ctx context.Context, statement string, args ...any) (pgx.Rows, error) {
	r.statement, r.args = statement, args
	return r.DBTX.Query(ctx, statement, args...)
}

func TestAgentMessageHistoryScopedQueryBoundsUnrelatedHistory(t *testing.T) {
	allowParallelIntegrationTest(t)
	// The small fixture carries the global/alias leakage and duplicate checks; service.Search
	// is too slow to run against the ten-thousand-message fixture, which skips it by design.
	for _, scale := range []struct {
		name                          string
		selected, unrelated, pageSize int
	}{{"small", 256, 512, 17}, {"ten_thousand_same_timestamp", 10000, 90000, 101}} {
		t.Run(scale.name, func(t *testing.T) {
			assertScopedHistoryQuery(t, scale.selected, scale.unrelated, scale.pageSize)
		})
	}
}

func assertScopedHistoryQuery(t *testing.T, selected, unrelated, pageSize int) {
	t.Helper()
	env, alice, _, roomID := newAgentCLIIdentity(t)
	otherRoom := createPrivateRoom(t, env, alice, "Unrelated history", "unrelated-history")
	noiseRooms := 1
	if selected == 10000 {
		noiseRooms = 9
	}
	seed, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer seed.Rollback(t.Context())
	// Historical ballast suppresses notifications only during fixture setup;
	// measured reads use the production query, constraints and authority.
	if _, err = seed.Exec(t.Context(), `SET LOCAL session_replication_role=replica`); err != nil {
		t.Fatal(err)
	}
	if _, err = seed.Exec(t.Context(), `
 INSERT INTO rooms(id,tenant_id,name,created_by_actor_id)
 SELECT 'history_noise_room_'||n,'tenant_acme','Unrelated history '||n,'actor_acme_alice' FROM generate_series(1,$5-1) n;
 INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,message_kind,created_at)
 SELECT 'history_scale_'||lpad(n::text,7,'0'),'tenant_acme',CASE WHEN n<=$3 THEN $1 WHEN (n-$3-1)%$5=0 THEN $2 ELSE 'history_noise_room_'||((n-$3-1)%$5) END,
 'actor_acme_alice',CASE WHEN n=1 THEN 'Scoped history scale needle' WHEN n<=$3 THEN 'Scoped history scale' ELSE 'Noise' END,
 jsonb_build_array(jsonb_build_object('type','text','content',CASE WHEN n=1 THEN 'Scoped history scale needle' WHEN n<=$3 THEN 'Scoped history scale' ELSE 'Noise' END)),
 'conversation','2026-01-01T00:00:00Z' FROM generate_series(1,$4) n;
 INSERT INTO room_events(event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload)
 SELECT 'event_history_scale_'||n,'tenant_acme',CASE WHEN n<=$3 THEN $1 WHEN (n-$3-1)%$5=0 THEN $2 ELSE 'history_noise_room_'||((n-$3-1)%$5) END,n+1000,
 'message.created','actor_acme_alice','history_scale_'||lpad(n::text,7,'0'),'{}' FROM generate_series(1,$4) n;
 INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,message_kind,created_at)
 VALUES('history_without_creation_event','tenant_acme',$1,'actor_acme_alice','Not a published history message',
 '[{"type":"text","content":"Not a published history message"}]','conversation','2027-01-01T00:00:00Z');
 UPDATE rooms SET next_room_seq=$4+1000 WHERE id IN ($1,$2)`, pgx.QueryExecModeSimpleProtocol, roomID, otherRoom, selected, selected+unrelated, noiseRooms); err != nil {
		t.Fatal(err)
	}
	if err = seed.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), `ANALYZE messages; ANALYZE room_events`); err != nil {
		t.Fatal(err)
	}
	task := createManagedTaskFixture(t, env, roomID, "history-scale-task")
	createTaskWorkRoomLink(t, env, task.ID, roomID)
	latestID := fmt.Sprintf("history_scale_%07d", selected)
	if _, err = env.pool.Exec(t.Context(), `UPDATE messages SET segments=jsonb_build_array(jsonb_build_object('type','document','content','@document','document_id','history_projection_document')) WHERE id=$2;
 UPDATE messages SET context_message_ids=ARRAY['history_scale_0000002','history_scale_0000001']
 WHERE id=$2 AND tenant_id='tenant_acme' AND room_id=$1`, pgx.QueryExecModeSimpleProtocol, roomID, latestID); err != nil {
		t.Fatal(err)
	}
	beforeCursors := historyCursorSnapshot(t, env)
	tx, err := env.pool.BeginTx(t.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	recorder := &historyQueryRecorder{DBTX: tx}
	queries := store.New(recorder)
	params := store.ReadAgentHistoryMessagesParams{
		TenantID: acmeTenant, ActorID: "actor_acme_official", InboxID: "room:" + roomID,
		InboxIds: []string{}, MessageIds: []string{}, PageLimit: 17,
	}
	for _, mode := range []string{"force_custom_plan", "force_generic_plan"} {
		t.Run(mode, func(t *testing.T) {
			if _, err = tx.Exec(t.Context(), "SET LOCAL plan_cache_mode="+mode); err != nil {
				t.Fatal(err)
			}
			params.CursorID, params.CursorTime = "", pgtype.Timestamptz{}
			first, readErr := queries.ReadAgentHistoryMessages(t.Context(), params)
			if readErr != nil || len(first) != 17 || first[0].MessageID != latestID {
				t.Fatalf("%s first page rows=%d err=%v", mode, len(first), readErr)
			}
			assertHistoryPageWork(t, tx, recorder, mode+" first", selected, unrelated, false)
			last := first[len(first)-1]
			params.CursorID, params.CursorTime = last.MessageID, last.CreatedAt
			second, readErr := queries.ReadAgentHistoryMessages(t.Context(), params)
			if readErr != nil || len(second) != 17 || second[0].MessageID != fmt.Sprintf("history_scale_%07d", selected-17) {
				t.Fatalf("%s second page rows=%d err=%v", mode, len(second), readErr)
			}
			assertHistoryPageWork(t, tx, recorder, mode+" second", selected, unrelated, false)
			params.CursorID = "history_scale_0000034"
			params.CursorTime = first[0].CreatedAt
			deep, readErr := queries.ReadAgentHistoryMessages(t.Context(), params)
			if readErr != nil || len(deep) != 17 || deep[0].MessageID != "history_scale_0000033" {
				t.Fatalf("%s deep page rows=%d err=%v", mode, len(deep), readErr)
			}
			assertHistoryPageWork(t, tx, recorder, mode+" deep", selected, unrelated, false)
			if selected == 10000 {
				params.PageLimit, params.CursorID, params.CursorTime = 101, "", pgtype.Timestamptz{}
				for n, page := range []string{"first", "second", "deep"} {
					expected := fmt.Sprintf("history_scale_%07d", selected-n*101)
					if page == "deep" {
						params.CursorID, params.CursorTime = "history_scale_0000202", first[0].CreatedAt
						expected = "history_scale_0000201"
					}
					full, readErr := queries.ReadAgentHistoryMessages(t.Context(), params)
					if readErr != nil || len(full) != 101 || full[0].MessageID != expected {
						t.Fatalf("%s full %s page rows=%d err=%v", mode, page, len(full), readErr)
					}
					assertHistoryPageWork(t, tx, recorder, mode+" full "+page, selected, unrelated, true)
					last := full[len(full)-1]
					params.CursorID, params.CursorTime = last.MessageID, last.CreatedAt
				}
				params.PageLimit = 17
			}
		})
	}
	if t.Failed() {
		return
	}
	params.CursorID, params.CursorTime = "", pgtype.Timestamptz{}
	params.PageLimit = int32(pageSize)
	rows, err := queries.ReadAgentHistoryMessages(t.Context(), params)
	if err != nil || len(rows) != pageSize {
		t.Fatalf("scoped first page rows=%d err=%v", len(rows), err)
	}
	var contextIDs []string
	if err = json.Unmarshal(rows[0].ContextMessageIds, &contextIDs); err != nil || !slices.Equal(contextIDs, []string{"history_scale_0000002", "history_scale_0000001"}) || !bytes.Contains(rows[0].ResourceReferences, []byte("history_projection_document")) {
		t.Fatalf("scoped projection lost ordered contexts/resource: %+v err=%v", rows[0], err)
	}
	seen := map[string]bool{}
	for len(rows) != 0 {
		for _, row := range rows {
			if row.InboxID != params.InboxID || seen[row.MessageID] {
				t.Fatalf("scoped history duplicated/wrong Inbox row: %+v", row)
			}
			seen[row.MessageID] = true
		}
		last := rows[len(rows)-1]
		params.CursorID, params.CursorTime = last.MessageID, last.CreatedAt
		rows, err = queries.ReadAgentHistoryMessages(t.Context(), params)
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != selected {
		t.Fatalf("tuple pagination read %d messages instead of %d", len(seen), selected)
	}
	for n := 1; n <= selected; n++ {
		if !seen[fmt.Sprintf("history_scale_%07d", n)] {
			t.Fatalf("tuple pagination omitted selected message %d", n)
		}
	}
	// The original small fixture covers global search and alias combinations.
	// This scale fixture targets ordered pages and current scope authority.
	if selected == 10000 {
		params.CursorID, params.CursorTime = "", pgtype.Timestamptz{}
		params.InboxID = "room:" + otherRoom
		rows, err = queries.ReadAgentHistoryMessages(t.Context(), params)
		if err != nil || len(rows) != 0 {
			t.Fatalf("large unauthorized selected Inbox rows=%d err=%v", len(rows), err)
		}
		if err = tx.Commit(t.Context()); err != nil {
			t.Fatal(err)
		}
		assertHistoryCursors(t, env, beforeCursors)
		return
	}
	params.CursorID, params.CursorTime, params.InboxID = "", pgtype.Timestamptz{}, ""
	service := agentmessages.New(env.pool)
	reader := agentmessages.Reader{TenantID: acmeTenant, ActorID: "actor_acme_official"}
	for _, scopes := range [][]string{{}, {"room:" + roomID, "task:" + task.ID, "room:" + roomID}} {
		page, readErr := service.Search(t.Context(), reader, agentmessages.SearchInput{Query: "Scoped history scale", InboxIDs: scopes, Limit: 100})
		if readErr != nil || len(page.Messages) != 100 {
			t.Fatalf("global/multiple alias history scopes=%v rows=%d err=%v", scopes, len(page.Messages), readErr)
		}
		unique := map[string]bool{}
		for _, row := range page.Messages {
			if !seen[row.MessageID] || unique[row.MessageID] || row.InboxID != "task:"+task.ID {
				t.Fatalf("global/multiple alias leaked or duplicated history: %+v", row)
			}
			unique[row.MessageID] = true
		}
	}
	params.InboxIds, params.Query = []string{"room:" + roomID}, "needle"
	rows, err = queries.ReadAgentHistoryMessages(t.Context(), params)
	if err != nil || len(rows) != 1 || rows[0].MessageID != "history_scale_0000001" {
		t.Fatalf("scoped search limited before matching an old message: %+v err=%v", rows, err)
	}
	params.InboxIds, params.Query = []string{"room:" + otherRoom}, "Scoped history scale"
	rows, err = queries.ReadAgentHistoryMessages(t.Context(), params)
	if err != nil || len(rows) != 0 {
		t.Fatalf("unauthorized selected Inbox rows=%d err=%v", len(rows), err)
	}
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	assertHistoryCursors(t, env, beforeCursors)
}

type historyPagePlan struct {
	Rows         float64           `json:"Actual Rows"`
	Loops        float64           `json:"Actual Loops"`
	Filtered     float64           `json:"Rows Removed by Filter"`
	JoinFiltered float64           `json:"Rows Removed by Join Filter"`
	Relation     string            `json:"Relation Name"`
	Plans        []historyPagePlan `json:"Plans"`
}

func (p historyPagePlan) work() (tree, source float64) {
	tree = (p.Rows + p.Filtered + p.JoinFiltered) * p.Loops
	if p.Relation != "" {
		source = (p.Rows + p.Filtered) * p.Loops
	}
	for _, child := range p.Plans {
		childTree, childSource := child.work()
		tree, source = tree+childTree, source+childSource
	}
	return
}

func assertHistoryPageWork(t *testing.T, tx pgx.Tx, recorder *historyQueryRecorder, label string, selected, unrelated int, fullPage bool) {
	t.Helper()
	var raw []byte
	if _, err := tx.Prepare(t.Context(), "history_page_work", recorder.statement); err != nil {
		t.Fatal(err)
	}
	parameters := make([]string, len(recorder.args))
	for n := range parameters {
		parameters[n] = fmt.Sprintf("$%d", n+1)
	}
	// EXPLAIN with bind arguments plans its utility statement as a custom
	// query. EXECUTE instead measures the production prepared statement under
	// the selected plan_cache_mode, including genuine parameter-blind plans.
	args := append([]any{pgx.QueryExecModeSimpleProtocol}, recorder.args...)
	statement := "EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) EXECUTE history_page_work(" + strings.Join(parameters, ",") + ")"
	if err := tx.QueryRow(t.Context(), statement, args...).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var plans []struct {
		Plan      historyPagePlan `json:"Plan"`
		Execution float64         `json:"Execution Time"`
	}
	if err := json.Unmarshal(raw, &plans); err != nil {
		t.Fatal(err)
	}
	work, sourceWork := plans[0].Plan.work()
	t.Logf("history %s plan: selected=%d unrelated=%d execution_ms=%.3f row_visits=%.0f source_row_visits=%.0f", label, selected, unrelated, plans[0].Execution, work, sourceWork)
	// Preserve the existing 17-row tree-work limit. For the actual 101-row API
	// page, bound physical table visits: view/Append wrappers count each
	// returned row repeatedly without reading more retained history.
	if fullPage {
		work = sourceWork
	}
	if work > 2048 {
		t.Fatalf("%s history page walks retained history: %.0f row visits exceeds 2048", label, work)
	}
}
