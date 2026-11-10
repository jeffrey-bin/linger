package integration_test

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcreationapproval"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// An Agent's Thread reply refreshes the parent timeline's Thread summary, as a
// Human's reply does (D-43).
func TestAgentThreadReplyUpdatesParentThreadSummary(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, issued, roomID := newAgentCLIIdentity(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	rootID := createHumanMessage(t, env, alice, roomID, "Thread root "+suffix, "agent-thread-root-"+suffix)
	thread := requestMessageThread(t, env, alice, roomID, rootID, "agent-thread-create-"+suffix)
	if thread.status != http.StatusCreated {
		t.Fatalf("create Thread status=%d body=%s", thread.status, thread.body)
	}
	// The mention lists the Agent on the Thread, which lets it reply there.
	createMentionMessage(t, env, alice, thread.room.ID, "agent-thread-mention-"+suffix, "actor_acme_official", "agent")
	before, _ := humanRoomEventsAfter(t, env, alice, roomID, 0)

	service := newAgentSendService(t, env.pool, agentauth.New(env.pool))
	sent, err := service.Send(agentauth.WithTarget(t.Context(), "room", roomID), issued.AccessToken, agentSendInput("thread:"+thread.room.ID, "agent-invocation-sha256:"+strings.Repeat("b", 64),
		agentsendmessage.PreparedSegment{Type: "text", Content: "Agent Thread reply " + suffix}))
	if err != nil || !sent.Accepted {
		t.Fatalf("Agent Thread reply result=%+v err=%v", sent, err)
	}

	after, _ := humanRoomEventsAfter(t, env, alice, roomID, before.LatestRoomSeq)
	if len(after.Items) != 1 || after.Items[0].EventType != "message.thread_summary.updated" {
		t.Fatalf("parent Room events after the Agent reply=%+v", after.Items)
	}
	var summary struct {
		MessageID string `json:"message_id"`
		Thread    struct {
			RoomID             string `json:"room_id"`
			ReplyCount         int    `json:"reply_count"`
			LatestReplyAuthors []struct {
				ID string `json:"id"`
			} `json:"latest_reply_authors"`
		} `json:"thread"`
	}
	decode(t, after.Items[0].Payload, &summary)
	if summary.MessageID != rootID || summary.Thread.RoomID != thread.room.ID || summary.Thread.ReplyCount != 2 ||
		len(summary.Thread.LatestReplyAuthors) != 2 || summary.Thread.LatestReplyAuthors[0].ID != "actor_acme_official" {
		t.Fatalf("Thread summary=%s", after.Items[0].Payload)
	}
	status, _, parent := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+rootID, nil, "")
	if status != http.StatusOK || !containsJSONText(parent, `"reply_count":2`) {
		t.Fatalf("parent Message after the Agent reply status=%d body=%s", status, parent)
	}
}

// A Thread has no members of its own, so a skill a Thread Message names must
// belong to an Agent of the parent Room (D-44). Only the Human front sends
// skills today; the core still checks them in the right Room.
func TestThreadMessageSkillBelongsToTheParentRoom(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _, roomID := newAgentCLIIdentity(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	rootID := createHumanMessage(t, env, alice, roomID, "Skill Thread root "+suffix, "skill-thread-root-"+suffix)
	thread := requestMessageThread(t, env, alice, roomID, rootID, "skill-thread-create-"+suffix)
	if thread.status != http.StatusCreated {
		t.Fatalf("create Thread status=%d body=%s", thread.status, thread.body)
	}
	ctx := t.Context()
	queries := store.New(env.pool)
	skills, err := queries.ListAgentSkillRegistrationsForAgents(ctx, []string{"actor_acme_official"})
	if err != nil || len(skills) == 0 {
		t.Fatalf("official Agent skills=%+v err=%v", skills, err)
	}
	author, err := queries.GetActor(ctx, store.GetActorParams{ID: "actor_acme_alice", TenantID: acmeTenant})
	if err != nil {
		t.Fatal(err)
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{
		{Type: "reference", Content: "@Official", Target: "actor_acme_official", TargetType: "agent"},
		{Type: "text", Content: " "},
		{Type: "skill", Content: "/skill", Target: "actor_acme_official", SkillID: skills[0].SkillID, ManifestVersion: skills[0].ManifestVersion},
	})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	created, err := messagecreation.Create(ctx, store.New(tx), messagecreation.Draft{
		TenantID: acmeTenant, RoomID: thread.room.ID, Author: author, Content: content,
	})
	if err != nil {
		t.Fatalf("Thread skill Message rejected: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if got := countRows(t, env, `select count(*) from messages where id=$1 and 'actor_acme_official'=ANY(mentioned_actor_ids)`, created.Message.ID); got != 1 {
		t.Fatalf("Thread skill Message mentions=%d want=1", got)
	}
}

// Human, Agent and card Messages announce one Message shape. It carries a
// relation only when one is set, the Human send returns exactly what it
// announces, and a later read of the Message agrees with the announcement.
func TestMessageCreatedPayloadIsOneShapeForEveryWriter(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, issued, roomID := newAgentCLIIdentity(t)
	ctx := agentauth.WithTarget(t.Context(), "room", roomID)
	contexts := agentauth.New(env.pool)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	start, _ := humanRoomEventsAfter(t, env, alice, roomID, 0)

	status, _, humanBody := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages",
		humanTextMessage("Human payload "+suffix), "payload-human-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("Human Message status=%d body=%s", status, humanBody)
	}
	var human map[string]any
	decode(t, humanBody, &human)
	humanID, _ := human["id"].(string)
	contextRequest := humanTextMessage("Human context payload " + suffix)
	contextRequest["context_message_ids"] = []string{humanID}
	if status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", contextRequest, "payload-context-"+suffix); status != http.StatusCreated {
		t.Fatalf("Human context Message status=%d body=%s", status, body)
	}

	input := agentSendInput("room:"+roomID, "agent-invocation-sha256:"+strings.Repeat("c", 64),
		agentsendmessage.PreparedSegment{Type: "text", Content: "Agent payload " + suffix})
	input.SourceMessageID = humanID
	sent, err := newAgentSendService(t, env.pool, contexts).Send(ctx, issued.AccessToken, input)
	if err != nil || !sent.Accepted {
		t.Fatalf("Agent Message result=%+v err=%v", sent, err)
	}

	// An AnotherMe asks its Human to approve a Room: a typed card Message.
	if _, err := env.pool.Exec(ctx, `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_alice' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	segments := []messagecreation.Segment{{Type: "text", Content: "Payload Room approval"}}
	members := []string{"actor_acme_alice", "actor_acme_official"}
	approval, err := agentcreationapproval.New(env.pool, contexts, typedcard.New(env.pool)).Submit(ctx, issued.AccessToken, agentcreationapproval.Input{
		RequestKind: "room_creation", InvocationID: "agent-invocation-sha256:" + strings.Repeat("d", 64),
		RoomCaller:    &agentcreationapproval.RoomCallerInput{Name: "Payload room " + suffix, MemberIDs: members, InitialMessageSegments: segments},
		RoomEffective: &agentcreationapproval.RoomEffectivePayload{Name: "Payload room " + suffix, MemberIDs: members, InitialMessageSegments: segments},
	})
	if err != nil || approval.CreationApprovalRequestID == "" {
		t.Fatalf("Room approval result=%+v err=%v", approval, err)
	}

	events, _ := humanRoomEventsAfter(t, env, alice, roomID, start.LatestRoomSeq)
	announced := map[string]map[string]any{}
	var order []string
	for _, event := range events.Items {
		if event.EventType != "message.created" {
			continue
		}
		var payload struct {
			Message map[string]any `json:"message"`
		}
		decode(t, event.Payload, &payload)
		id, _ := payload.Message["id"].(string)
		announced[id] = payload.Message
		order = append(order, id)
	}
	if len(order) != 4 {
		t.Fatalf("announced Messages=%v want Human, context, Agent and card", order)
	}
	if !reflect.DeepEqual(announced[humanID], human) {
		t.Fatalf("Human send returned %s, announced %v", humanBody, announced[humanID])
	}

	required := []string{"id", "tenant_id", "room_id", "author", "message_kind", "raw_message", "segments", "attachments", "created_at"}
	relations := map[string]string{order[1]: "context_messages", order[2]: "reply_to_message_id", order[3]: "card"}
	for _, id := range order {
		message := announced[id]
		want := map[string]bool{}
		for _, key := range required {
			want[key] = true
		}
		if relation := relations[id]; relation != "" {
			want[relation] = true
		}
		got := map[string]bool{}
		for key := range message {
			got[key] = true
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Message %s announced keys=%v want=%v payload=%v", id, got, want, message)
		}
		status, _, readBody := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+id, nil, "")
		if status != http.StatusOK {
			t.Fatalf("read Message %s status=%d body=%s", id, status, readBody)
		}
		var read map[string]any
		decode(t, readBody, &read)
		for key, value := range message {
			if key == "created_at" {
				if !sameInstant(t, value, read[key]) {
					t.Fatalf("Message %s created_at announced=%v read=%v", id, value, read[key])
				}
				continue
			}
			if !reflect.DeepEqual(value, read[key]) {
				t.Fatalf("Message %s %s announced=%v read=%v", id, key, value, read[key])
			}
		}
	}
	if announced[order[2]]["reply_to_message_id"] != humanID {
		t.Fatalf("Agent reply relation=%v want %s", announced[order[2]]["reply_to_message_id"], humanID)
	}
}

func sameInstant(t *testing.T, left, right any) bool {
	t.Helper()
	parse := func(value any) time.Time {
		text, _ := value.(string)
		parsed, err := time.Parse(time.RFC3339Nano, text)
		if err != nil {
			t.Fatalf("timestamp %v: %v", value, err)
		}
		return parsed
	}
	return parse(left).Equal(parse(right))
}

type humanRoomEvent struct {
	RoomSeq   int64           `json:"room_seq"`
	EventType string          `json:"event_type"`
	Payload   json.RawMessage `json:"payload"`
}

type humanRoomEventPage struct {
	Items         []humanRoomEvent `json:"items"`
	LatestRoomSeq int64            `json:"latest_room_seq"`
}

func humanRoomEventsAfter(t *testing.T, env *testEnv, client *http.Client, roomID string, after int64) (humanRoomEventPage, []byte) {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet,
		"/v0/rooms/"+roomID+"/events?after="+strconv.FormatInt(after, 10)+"&limit=100", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Room events status=%d body=%s", status, body)
	}
	var page humanRoomEventPage
	decode(t, body, &page)
	return page, body
}
