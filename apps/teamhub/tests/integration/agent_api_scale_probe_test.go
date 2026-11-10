//go:build integration_performance

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

type scaleRequestKey struct{}
type scaleObservation struct {
	RequestID     string  `json:"request_id"`
	DurationMS    float64 `json:"duration_ms"`
	Queries       int     `json:"queries"`
	Revalidations int     `json:"revalidations"`
}
type scaleQuery struct {
	sql  string
	args []any
}
type scaleTracer struct {
	mu           sync.Mutex
	observations map[string]*scaleObservation
	explain      map[string]scaleQuery
}

func (s *scaleTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	id, _ := ctx.Value(scaleRequestKey{}).(string)
	if id == "" {
		return ctx
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	o := s.observations[id]
	o.Queries++
	if strings.Contains(data.SQL, "SELECT true FROM agent_access_credentials") {
		o.Revalidations++
	}
	if strings.Contains(data.SQL, "WITH registration AS MATERIALIZED") {
		label := "docs_ls_first"
		if data.Args[2] != "" {
			label = "docs_ls_last"
		}
		s.explain[label] = scaleQuery{data.SQL, data.Args}
	}
	return ctx
}
func (*scaleTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// Run serially against disposable PostgreSQL. Emits server-side time, never
// bearer tokens or business bodies; the retained Request ID joins every sample.
func TestAgentAPIScaleProbe(t *testing.T) {
	for _, scale := range []struct {
		name                 string
		docs, humans, events int
	}{{"small", 30, 3, 100}, {"large", 3000, 48, 100000}} {
		t.Run(scale.name, func(t *testing.T) {
			tracer := &scaleTracer{observations: map[string]*scaleObservation{}, explain: map[string]scaleQuery{}}
			env, _, issued, roomID := newAgentCLIIdentity(t, withQueryTracer(tracer))
			ctx := t.Context()
			_, err := env.pool.Exec(ctx, `INSERT INTO accounts(id,email,password_hash)
 SELECT 'scale_account_'||n,'scale-human-'||n||'@example.com','x' FROM generate_series(1,$1::int) n;
 INSERT INTO actors(id,tenant_id,kind,display_name,account_id)
 SELECT 'scale_human_'||n,'tenant_acme','human','Scale Human','scale_account_'||n FROM generate_series(1,$1::int) n;
 INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
 SELECT $2,'tenant_acme','scale_human_'||n,'member','actor_acme_alice' FROM generate_series(1,$1::int) n`, pgx.QueryExecModeSimpleProtocol, scale.humans, roomID)
			// pgx extended protocol cannot prepare multi-statement SQL with parameters.
			if err != nil {
				t.Fatal(err)
			}
			_, err = env.pool.Exec(ctx, `INSERT INTO documents(id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status)
 SELECT 'scale_doc_'||lpad(n::text,6,'0'),'tenant_acme','Scale doc','text','actor_acme_official','agent','actor_acme_official','agent','active' FROM generate_series(1,$1::int) n`, scale.docs)
			if err != nil {
				t.Fatal(err)
			}
			// Historical events are only scan ballast. Suppress their notifications
			// while seeding; every measured request still runs all production triggers.
			history, err := env.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = history.Exec(ctx, `SET LOCAL session_replication_role=replica`); err != nil {
				t.Fatal(err)
			}
			_, err = history.Exec(ctx, `INSERT INTO room_events(event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload)
 SELECT 'scale_event_'||n,'tenant_acme',$1,n+1000000,'message.created','actor_acme_official','scale_message_'||n,'{}' FROM generate_series(1,$2::int) n`, roomID, scale.events)
			if err != nil {
				history.Rollback(ctx)
				t.Fatal(err)
			}
			if err = history.Commit(ctx); err != nil {
				t.Fatal(err)
			}

			if _, err = env.pool.Exec(ctx, `UPDATE rooms SET next_room_seq=$2 WHERE id=$1`, roomID, scale.events+1000000); err != nil {
				t.Fatal(err)
			}
			if _, err = env.pool.Exec(ctx, `ANALYZE`); err != nil {
				t.Fatal(err)
			}
			handler := env.server.Config.Handler
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				id := r.Header.Get("X-Request-ID")
				tracer.mu.Lock()
				tracer.observations[id] = &scaleObservation{RequestID: id}
				tracer.mu.Unlock()
				started := time.Now()
				handler.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), scaleRequestKey{}, id)))
				tracer.mu.Lock()
				tracer.observations[id].DurationMS = float64(time.Since(started).Microseconds()) / 1000
				tracer.mu.Unlock()
			}))
			defer server.Close()
			request := func(id, method, requestPath, mediaType string, body []byte) []byte {
				req, err := http.NewRequestWithContext(ctx, method, server.URL+requestPath, bytes.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Authorization", "Bearer "+issued.AccessToken)
				req.Header.Set("X-Request-ID", id)
				req.Header.Set("Content-Type", mediaType)
				req.Header.Set("X-TeamHub-Context-Kind", "room")
				req.Header.Set("X-TeamHub-Context-Id", roomID)
				response, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				data, err := io.ReadAll(response.Body)
				if err != nil {
					t.Fatal(err)
				}
				if response.StatusCode < 200 || response.StatusCode >= 300 {
					t.Fatalf("%s HTTP %d: %s", id, response.StatusCode, data)
				}
				return data
			}
			for _, scenario := range []string{"docs_ls", "docs_ls_all", "message_send"} {
				if selected := os.Getenv("TEAMHUB_SCALE_SCENARIOS"); selected != "" && !slices.Contains(strings.Split(selected, ","), scenario) {
					continue
				}
				for sample := 0; sample < 21; sample++ {
					id := fmt.Sprintf("scale-%s-%s-%02d", scale.name, scenario, sample)
					switch scenario {
					case "docs_ls":
						request(id, "GET", "/api/agent/v1/files?limit=100", "", nil)
					case "docs_ls_all":
						after := ""
						page := 0
						for {
							data := request(fmt.Sprintf("%s-page-%d", id, page), "GET", "/api/agent/v1/files?limit=100&after_id="+url.QueryEscape(after), "", nil)
							var result struct {
								Files []struct {
									ID string `json:"document_id"`
								} `json:"files"`
							}
							if err := json.Unmarshal(data, &result); err != nil {
								t.Fatal(err)
							}
							if len(result.Files) == 0 {
								break
							}
							after = result.Files[len(result.Files)-1].ID
							page++
							if page > 100 {
								t.Fatal("pagination did not converge")
							}
						}
						tracer.mu.Lock()
						total := &scaleObservation{RequestID: id}
						for n := 0; n <= page; n++ {
							o := tracer.observations[fmt.Sprintf("%s-page-%d", id, n)]
							total.DurationMS += o.DurationMS
							total.Queries += o.Queries
						}
						tracer.observations[id] = total
						tracer.mu.Unlock()
					case "message_send":
						contentType, body := agentMessageCommitBody(t, agentTextMessage("room:"+roomID, id, "Scale probe"))
						request(id, "POST", "/api/agent/v1/messages/commit", contentType, body)
					}
					tracer.mu.Lock()
					observation := *tracer.observations[id]
					tracer.mu.Unlock()
					encoded, _ := json.Marshal(observation)
					t.Logf("scale_sample %s", encoded)
				}
				durations := []float64{}
				queries := []int{}
				for sample := 1; sample < 21; sample++ {
					o := tracer.observations[fmt.Sprintf("scale-%s-%s-%02d", scale.name, scenario, sample)]
					durations = append(durations, o.DurationMS)
					queries = append(queries, o.Queries)
				}
				sort.Float64s(durations)
				sort.Ints(queries)
				t.Logf("scale_summary scale=%s scenario=%s docs=%d humans=%d events=%d n=20 p50_ms=%.3f p95_ms=%.3f queries_p50=%d", scale.name, scenario, scale.docs, scale.humans, scale.events, durations[9], durations[18], queries[9])
			}
			for label, query := range tracer.explain {
				tx, err := env.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(ctx)
				rows, err := tx.Query(ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+query.sql, query.args...)
				if err != nil {
					tx.Rollback(ctx)
					t.Fatal(err)
				}
				for rows.Next() {
					var plan string
					if err := rows.Scan(&plan); err != nil {
						t.Fatal(err)
					}
					t.Logf("scale_explain scale=%s query=%s plan=%s", scale.name, label, plan)
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
				rows.Close()
				tx.Rollback(ctx)
			}
		})
	}
}

// Populate every discovery source, with interleaved IDs so deep pages leave
// records in every branch. Compare on disposable databases before/after SQL.
func TestAgentFileMixedSourceScaleProbe(t *testing.T) {
	_, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	ctx := t.Context()
	_, err := pool.Exec(ctx, `UPDATE agent_registrations SET user_artifact_owner_actor_id='actor_human_a' WHERE actor_id='actor_agent_a';
INSERT INTO accounts(id,email,password_hash) VALUES('account_mixed_owner','mixed-owner@example.com','x');
INSERT INTO actors(id,tenant_id,kind,display_name,account_id) VALUES('actor_mixed_owner','tenant_document_a','human','Mixed owner','account_mixed_owner');
INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id) VALUES
('room_document_a','tenant_document_a','actor_agent_a','member','actor_human_a'),
('room_document_a','tenant_document_a','actor_human_a','owner','actor_human_a');
INSERT INTO work_items(id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id) VALUES
('item_mixed_human','tenant_document_a',104,'issue','Human only','actor_mixed_owner','actor_mixed_owner'),
('item_mixed_creator','tenant_document_a',102,'issue','Created','actor_agent_a','actor_agent_a'),
('item_mixed_grant','tenant_document_a',103,'issue','Granted','actor_mixed_owner','actor_mixed_owner');
INSERT INTO work_item_access_grants(work_item_id,tenant_id,actor_id,granted_by_actor_id) VALUES('item_mixed_grant','tenant_document_a','actor_agent_a','actor_mixed_owner');
INSERT INTO personal_wikis(id,tenant_id,owner_actor_id) VALUES('wiki_mixed_other','tenant_document_a','actor_mixed_owner');
INSERT INTO document_wiki_refreshes(id,tenant_id,wiki_id,generator_agent_actor_id,status)
VALUES('refresh_mixed','tenant_document_a','wiki_mixed_other','actor_agent_a','staging');
INSERT INTO documents(id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status)
SELECT 'mixed_'||lpad(n::text,6,'0'),'tenant_document_a','Mixed document','text',
CASE WHEN n%10=0 THEN 'actor_agent_a' WHEN n%10=9 THEN 'actor_human_a' ELSE 'actor_mixed_owner' END,
CASE WHEN n%10=0 THEN 'agent' ELSE 'human' END,'actor_mixed_owner','human','active'
FROM generate_series(1,10000) n;
INSERT INTO document_direct_collaborators(id,tenant_id,document_id,target_actor_id,role,status,grantor_actor_id,version)
SELECT 'mixed_collaborator_'||n,'tenant_document_a','mixed_'||lpad(n::text,6,'0'),
CASE WHEN n%20=1 THEN 'actor_agent_a' ELSE 'actor_human_a' END,'viewer','active','actor_mixed_owner',1
FROM generate_series(1,10000) n WHERE n%10=1;
INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,room_id,work_item_id,wiki_id,role,status)
SELECT 'mixed_binding_'||n,'tenant_document_a','mixed_'||lpad(n::text,6,'0'),
CASE WHEN n%10=2 THEN 'room' WHEN n%10 BETWEEN 3 AND 6 THEN 'task' ELSE 'wiki_source' END,
CASE WHEN n%10=2 THEN 'room_document_a' END,
CASE n%10 WHEN 3 THEN 'item_mixed_human' WHEN 4 THEN 'item_mixed_creator' WHEN 5 THEN 'work_item_document_a' WHEN 6 THEN 'item_mixed_grant' END,
CASE n%10 WHEN 7 THEN 'wiki_mixed_other' WHEN 8 THEN 'wiki_document_a' END,'viewer','active'
FROM generate_series(1,10000) n WHERE n%10 BETWEEN 2 AND 8;
INSERT INTO document_placements(id,tenant_id,scope_kind,owner_human_actor_id,node_kind,document_id,sort_key)
SELECT 'mixed_placement_'||n,'tenant_document_a','personal','actor_human_a','document','mixed_'||lpad(n::text,6,'0'),n::text
FROM generate_series(1,10000) n WHERE n%10=9;
ANALYZE`)
	if err != nil {
		t.Fatal(err)
	}
	tracer := &scaleTracer{observations: map[string]*scaleObservation{}, explain: map[string]scaleQuery{}}
	config := pool.Config().Copy()
	config.ConnConfig.Tracer = tracer
	readPool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer readPool.Close()
	service := document.NewWithObjectStore(readPool, objects)
	for _, after := range []string{"", "mixed_009000", "mixed_009950"} {
		requestID := "mixed-" + after
		tracer.observations[requestID] = &scaleObservation{RequestID: requestID}
		requestCtx := context.WithValue(ctx, scaleRequestKey{}, requestID)
		started := time.Now()
		files, err := service.ListAgentFiles(requestCtx, "tenant_document_a", "agent_document_a", after, 100, false)
		if err != nil {
			t.Fatal(err)
		}
		if after == "mixed_009950" && len(files) != 50 {
			t.Fatalf("last page=%d", len(files))
		}
		if len(files) == 0 || files[0].DocumentID <= after {
			t.Fatalf("invalid page after=%q files=%v", after, files)
		}
		t.Logf("mixed_summary documents=10000 sources=10 cursor=%q page_size=%d duration_ms=%.3f", after, len(files), float64(time.Since(started).Microseconds())/1000)
		label := "docs_ls_first"
		if after != "" {
			label = "docs_ls_last"
		}
		query := tracer.explain[label]
		var plan string
		if err := pool.QueryRow(ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+query.sql, query.args...).Scan(&plan); err != nil {
			t.Fatal(err)
		}
		t.Logf("mixed_explain cursor=%q plan=%s", after, plan)
	}
}
