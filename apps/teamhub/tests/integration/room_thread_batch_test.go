package integration_test

import (
	"fmt"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestRoomThreadBatchReplyAuthors(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	ctx := t.Context()
	parentID := createPrivateRoom(t, env, alice, "Batch Threads", "batch-parent")
	var roots, threads []string
	for i := 0; i < 4; i++ { // Two populated, one empty, one not selected by the batch.
		root := createHumanMessage(t, env, alice, parentID, fmt.Sprintf("Root %d", i), fmt.Sprintf("batch-root-%d", i))
		created := requestMessageThread(t, env, alice, parentID, root, fmt.Sprintf("batch-thread-%d", i))
		if created.status != http.StatusCreated {
			t.Fatalf("create Thread: %d %s", created.status, created.body)
		}
		roots, threads = append(roots, root), append(threads, created.room.ID)
	}
	for i := 0; i < 4; i++ {
		id := fmt.Sprintf("actor_batch_%d", i)
		if _, err := env.pool.Exec(ctx, `INSERT INTO actors(id, tenant_id, kind, display_name, handle) VALUES ($1,$2,'agent',$1,$1)`, id, acmeTenant); err != nil {
			t.Fatal(err)
		}
	}
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	insert := func(roomID, id, author, kind string, createdAt time.Time) {
		t.Helper()
		_, err := env.pool.Exec(ctx, `INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,message_kind,created_at)
			VALUES ($1,$2,$3,$4,'reply','[{"type":"text","content":"reply"}]',$5,$6)`, id, acmeTenant, roomID, author, kind, createdAt)
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, i := range []int{0, 1, 3} {
		for author := 0; author < 4; author++ {
			insert(threads[i], fmt.Sprintf("reply-%d-%d", i, author), fmt.Sprintf("actor_batch_%d", author), "conversation", at)
		}
		// A duplicate author must move to the front without occupying two slots.
		insert(threads[i], fmt.Sprintf("reply-%d-z", i), "actor_batch_0", "conversation", at.Add(time.Second))
		// Hidden Runtime messages must not affect the author list or latest reply time.
		insert(threads[i], fmt.Sprintf("status-%d", i), "actor_batch_1", "agent_runtime", at.Add(time.Hour))
	}
	insert(parentID, "parent-not-thread", "actor_batch_1", "conversation", at.Add(time.Hour))
	queries := store.New(env.pool)
	rows, err := queries.ListLatestThreadReplyAuthorsBatch(ctx, append(append([]string{}, threads[:3]...), threads[0], parentID, "missing"))
	if err != nil {
		t.Fatal(err)
	}
	byThread := map[string][]store.Actor{}
	for _, row := range rows {
		byThread[row.RoomID] = append(byThread[row.RoomID], row.Actor)
	}
	if len(rows) != 6 || len(byThread) != 2 {
		t.Fatalf("per-Thread limit/scope failed: %+v", rows)
	}
	for _, threadID := range threads[:3] {
		single, err := queries.ListLatestThreadReplyAuthors(ctx, threadID)
		if err != nil {
			t.Fatal(err)
		}
		if len(single) != len(byThread[threadID]) || len(single) > 0 && !reflect.DeepEqual(single, byThread[threadID]) {
			t.Fatalf("batch changed single-Thread results: single=%+v batch=%+v", single, byThread[threadID])
		}
		if len(single) > 0 {
			for i, want := range []string{"actor_batch_0", "actor_batch_3", "actor_batch_2"} {
				if single[i].ID != want {
					t.Fatalf("distinct/tie ordering: %+v", single)
				}
			}
		}
	}
	if rows, err := queries.ListLatestThreadReplyAuthorsBatch(ctx, nil); err != nil || len(rows) != 0 {
		t.Fatalf("empty selection: %+v %v", rows, err)
	}
	status, _, body := env.request(alice, http.MethodGet, "/v0/rooms/"+parentID+"/messages?limit=50", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list messages: %d %s", status, body)
	}
	var page httpapi.MessagePage
	decode(t, body, &page)
	summaries := map[string]*httpapi.MessageThreadSummary{}
	for _, message := range page.Items {
		summaries[message.Id] = message.Thread
	}
	for i, rootID := range roots {
		summary := summaries[rootID]
		if summary == nil || summary.RoomId != threads[i] {
			t.Fatalf("missing/wrong Thread summary: root=%s summary=%+v", rootID, summary)
		}
		if i == 2 {
			if summary.ReplyCount != 0 || summary.LatestReplyAuthors != nil || summary.LatestReplyAt != nil {
				t.Fatalf("empty Thread changed: %+v", summary)
			}
			continue
		}
		if summary.ReplyCount != 5 || summary.LatestReplyAt == nil || !summary.LatestReplyAt.Equal(at.Add(time.Second)) || summary.LatestReplyAuthors == nil || len(*summary.LatestReplyAuthors) != 3 {
			t.Fatalf("wrong summary: %+v", summary)
		}
		for j, want := range []string{"actor_batch_0", "actor_batch_3", "actor_batch_2"} {
			if (*summary.LatestReplyAuthors)[j].Id != want {
				t.Fatalf("HTTP author order changed: %+v", summary.LatestReplyAuthors)
			}
		}
	}
	if summaries["parent-not-thread"] != nil {
		t.Fatal("ordinary Message acquired a Thread summary")
	}
}
