package integration_test

import (
	"bufio"
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"
)

func TestRoomSummaryExcludesInternalCardDecisionReceipt(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Decision receipt "+suffix, "decision-receipt-room-"+suffix)
	visibleMessageID, _ := createTriggerMessage(t, env, alice, roomID, "Readable update", "visible-message-"+suffix)

	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	var roomSeq int64
	if err := tx.QueryRow(t.Context(), `
		update rooms set next_room_seq=next_room_seq+1 where id=$1 returning next_room_seq
	`, roomID).Scan(&roomSeq); err != nil {
		t.Fatal(err)
	}
	receiptMessageID := "message-decision-receipt-" + suffix
	if _, err := tx.Exec(t.Context(), `
		insert into messages(id,tenant_id,room_id,author_actor_id,body,segments,card_context_message_id,message_kind)
		values(
			$1,$2,$3,'actor_acme_alice','Decision outcome: kind=task_creation decision=approved',
			'[{"type":"text","content":"Decision outcome: kind=task_creation decision=approved"}]'::jsonb,
			$4,'conversation'
		)
	`, receiptMessageID, acmeTenant, roomID, visibleMessageID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
		insert into room_events(event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload)
		values($1,$2,$3,$4,'message.created','actor_acme_alice',$5,'{}')
	`, "event-decision-receipt-"+suffix, acmeTenant, roomID, roomSeq, receiptMessageID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	var latestConversationMessageID string
	if err := env.pool.QueryRow(t.Context(), `
		select message.id
		from room_events event
		join messages message on message.id=event.resource_id and message.room_id=event.room_id
		where event.room_id=$1 and event.event_type='message.created' and message.message_kind='conversation'
		order by event.room_seq desc
		limit 1
	`, roomID).Scan(&latestConversationMessageID); err != nil {
		t.Fatal(err)
	}
	if latestConversationMessageID != receiptMessageID {
		t.Fatalf("test setup latest Message=%q want=%q", latestConversationMessageID, receiptMessageID)
	}

	roomSummary := roomListItemByID(t, env, alice, roomID)
	if roomSummary.LatestMessage == nil || roomSummary.LatestMessage.ID != visibleMessageID {
		t.Fatalf("internal decision receipt replaced latest visible Message: %+v", roomSummary.LatestMessage)
	}
}

func createTriggerMessage(t *testing.T, env *testEnv, client *http.Client, roomID, text, key string) (string, int64) {
	t.Helper()
	status, _, body := env.request(client, http.MethodPost, "/v0/rooms/"+roomID+"/messages", humanTextMessage(text), key)
	if status != http.StatusCreated {
		t.Fatalf("create trigger status=%d body=%s", status, body)
	}
	var message struct {
		ID string `json:"id"`
	}
	decode(t, body, &message)
	var roomSeq int64
	if err := env.pool.QueryRow(context.Background(), `select room_seq from room_events where room_id=$1 and resource_id=$2 and event_type='message.created'`, roomID, message.ID).Scan(&roomSeq); err != nil {
		t.Fatal(err)
	}
	return message.ID, roomSeq
}

func nextNamedSSE(t *testing.T, reader *bufio.Reader) sseRecord {
	t.Helper()
	for {
		record := readSSERecord(t, reader)
		if record.Event != "" {
			return record
		}
	}
}
