package integration_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestRoomMemberMutationsConcurrentMessage(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, mutation := range []string{"admit", "role", "remove"} {
		t.Run(mutation, func(t *testing.T) {
			env := newRoomMembershipEnv(t)
			alice := env.login("alice", alicePassword)
			// Admission, role change and removal of a Human member.
			seedPeerHumanActor(t, env.pool)
			roomID := createPrivateRoom(t, env, alice, "Membership and Message", "member-message-room")
			method, code, role := http.MethodPut, http.StatusOK, "member"
			var payload any = map[string]any{"role": role}
			if mutation != "admit" {
				if response, body := putRoomMember(t, env, alice, roomID, "actor_acme_bob", "member"); response != http.StatusOK {
					t.Fatalf("prepare Bob membership=%d body=%s", response, body)
				}
				if mutation == "role" {
					role, payload = "owner", map[string]any{"role": "owner"}
				} else {
					method, code, payload = http.MethodDelete, http.StatusNoContent, nil
				}
			}
			holder, err := env.pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			// Pause a Message writer after taking the same Room row as AllocateRoomSeq.
			// Human HTTP messages share the membership advisory lock; Agent Message
			// persistence uses this transaction boundary without that advisory lock.
			if _, err := holder.Exec(t.Context(), `SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE`, roomID); err != nil {
				t.Fatal(err)
			}
			results := make(chan asyncHTTPResult, 1)
			if err := startAsyncJSONRequest(results, "admission", alice, method,
				env.server.URL+"/v0/rooms/"+roomID+"/members/actor_acme_bob", "",
				payload); err != nil {
				t.Fatal(err)
			}
			waitForLockWaiter(t, env)
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			queries := store.New(holder)
			author, err := queries.GetActor(ctx, store.GetActorParams{ID: "actor_acme_alice", TenantID: acmeTenant})
			if err != nil {
				t.Fatal(err)
			}
			message, err := messagecreation.Create(ctx, queries, messagecreation.Draft{
				TenantID: acmeTenant, RoomID: roomID, Author: author, Content: messagecreation.Content{
					RawMessage: "Message concurrent with admission",
					Segments:   []messagecreation.Segment{{Type: "text", Content: "Message concurrent with admission"}},
				},
			})
			if err != nil {
				t.Fatalf("competing Message transaction: %v", err)
			}
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case result := <-results:
				if result.err != nil || result.status != code {
					t.Fatalf("admission status=%d err=%v body=%s", result.status, result.err, result.body)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			want := 1
			if mutation == "remove" {
				want = 0
			}
			if got := countRows(t, env, `SELECT count(*) FROM active_room_members WHERE room_id=$1 AND actor_id='actor_acme_bob' AND role=$2`, roomID, role); got != want {
				t.Fatalf("committed Bob memberships=%d want=%d", got, want)
			}
			if got := countRows(t, env, `SELECT count(*) FROM room_events WHERE room_id=$1 AND event_type='message.created' AND resource_id=$2`, roomID, message.Message.ID); got != 1 {
				t.Fatalf("committed Message events=%d want=1", got)
			}
		})
	}
}
