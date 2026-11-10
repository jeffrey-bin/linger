package typedcard

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// A connection card names only its app or Computer; an Agent can never bind
// the Human's Connection while opening one.
func TestConnectionDecisionsDraftTheirOwnCards(t *testing.T) {
	t.Parallel()
	draft, err := DecisionCommand{ConnectionAuth: &ConnectionAuthDecision{Prompt: " Connect Notion ", AppKey: " notion "}}.draft()
	if err != nil || draft.kind != DecisionKindConnectionAuth || draft.text != "Connect Notion" || !draft.connection ||
		draft.lifetime != connectionAuthorizationTTL || draft.view.(connectionView).AppKey != "notion" {
		t.Fatalf("connection_auth draft=%+v err=%v", draft, err)
	}
	draft, err = DecisionCommand{ProviderKey: &ProviderKeyDecision{Prompt: " Add a key ", AppKey: " higgsfield "}}.draft()
	if err != nil || draft.kind != DecisionKindProviderKey || draft.text != "Add a key" || !draft.connection ||
		draft.lifetime != 0 || draft.view.(connectionView).AppKey != "higgsfield" {
		t.Fatalf("provider_key draft=%+v err=%v", draft, err)
	}
	draft, err = DecisionCommand{ProviderKey: &ProviderKeyDecision{Prompt: "Add a key"}}.draft()
	if err != nil || draft.view.(connectionView).AppKey != "" {
		t.Fatalf("provider_key draft without an app=%+v err=%v", draft, err)
	}
	draft, err = DecisionCommand{BrowserConnection: &BrowserConnectionDecision{Prompt: "Connect Chrome", ComputerID: "computer-1"}}.draft()
	if err != nil || draft.kind != DecisionKindBrowserConnection || draft.lifetime != 0 || !draft.connection {
		t.Fatalf("browser_connection draft=%+v err=%v", draft, err)
	}
	draft, err = DecisionCommand{ComputerPermission: &ComputerPermissionDecision{ComputerID: "computer-1", Subject: "linger",
		Permissions: []string{"screen_recording", "accessibility"}, Reason: " Take a screenshot "}}.draft()
	if err != nil || draft.kind != DecisionKindComputerPermission || draft.lifetime != connectionAuthorizationTTL || !draft.connection || draft.text != computerPermissionTitle {
		t.Fatalf("computer_permission draft=%+v err=%v", draft, err)
	}
	if view := draft.view.(computerPermissionView); view.Reason != "Take a screenshot" || strings.Join(view.Permissions, ",") != "accessibility,screen_recording" {
		t.Fatalf("computer_permission view=%+v", view)
	}
	for name, command := range map[string]DecisionCommand{
		"no app":             {ConnectionAuth: &ConnectionAuthDecision{Prompt: "Connect"}},
		"key without prompt": {ProviderKey: &ProviderKeyDecision{AppKey: "notion"}},
		"key and app":        {ProviderKey: &ProviderKeyDecision{Prompt: "a", AppKey: "notion"}, ConnectionAuth: &ConnectionAuthDecision{Prompt: "b", AppKey: "notion"}},
		"no permission":      {ComputerPermission: &ComputerPermissionDecision{ComputerID: "c", Subject: "linger"}},
		"bad permission":     {ComputerPermission: &ComputerPermissionDecision{ComputerID: "c", Subject: "linger", Permissions: []string{"camera"}}},
		"permission twice":   {ComputerPermission: &ComputerPermissionDecision{ComputerID: "c", Subject: "linger", Permissions: []string{"accessibility", "accessibility"}}},
		"bad subject":        {ComputerPermission: &ComputerPermissionDecision{ComputerID: "c", Subject: "cua", Permissions: []string{"accessibility"}}},
		"long reason":        {ComputerPermission: &ComputerPermissionDecision{ComputerID: "c", Subject: "linger", Permissions: []string{"accessibility"}, Reason: strings.Repeat("x", 201)}},
		"permission + chrome": {ComputerPermission: &ComputerPermissionDecision{ComputerID: "c", Subject: "linger", Permissions: []string{"accessibility"}},
			BrowserConnection: &BrowserConnectionDecision{Prompt: "b", ComputerID: "c"}},
		"no prompt":         {ConnectionAuth: &ConnectionAuthDecision{AppKey: "notion"}},
		"bad computer":      {BrowserConnection: &BrowserConnectionDecision{Prompt: "Connect", ComputerID: "../computer"}},
		"connection twice":  {ConnectionAuth: &ConnectionAuthDecision{Prompt: "a", AppKey: "notion"}, BrowserConnection: &BrowserConnectionDecision{Prompt: "b", ComputerID: "c"}},
		"too long a prompt": {ConnectionAuth: &ConnectionAuthDecision{Prompt: strings.Repeat("x", 2001), AppKey: "notion"}},
	} {
		if _, err := command.draft(); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s: err=%v, want ErrInvalid", name, err)
		}
	}
}

func TestNormalizeDecisionAnswerForConnectionAndRoomKinds(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		kind    string
		command DecisionAnswerCommand
		status  string
	}{
		{DecisionKindConnectionAuth, DecisionAnswerCommand{Decision: "approve", ConnectionID: "connection_notion"}, "denied"},
		{DecisionKindConnectionAuth, DecisionAnswerCommand{Decision: "deny"}, "denied"},
		{DecisionKindConnectionAuth, DecisionAnswerCommand{Decision: "approve"}, ""},
		{DecisionKindConnectionAuth, DecisionAnswerCommand{Decision: "deny", ConnectionID: "connection_notion"}, ""},
		{DecisionKindConnectionAuth, DecisionAnswerCommand{Decision: "submit"}, ""},
		{DecisionKindProviderKey, DecisionAnswerCommand{Decision: "deny"}, "denied"},
		{DecisionKindProviderKey, DecisionAnswerCommand{Decision: "configured"}, ""},
		{DecisionKindProviderKey, DecisionAnswerCommand{Decision: "approve"}, ""},
		{DecisionKindBrowserConnection, DecisionAnswerCommand{Decision: "deny"}, "denied"},
		{DecisionKindBrowserConnection, DecisionAnswerCommand{Decision: "connected"}, ""},
		{DecisionKindBrowserConnection, DecisionAnswerCommand{Decision: "deny", Comment: "no"}, ""},
		{DecisionKindComputerPermission, DecisionAnswerCommand{Decision: "deny"}, "denied"},
		{DecisionKindComputerPermission, DecisionAnswerCommand{Decision: "granted"}, ""},
		{DecisionKindComputerPermission, DecisionAnswerCommand{Decision: "approve"}, ""},
		{DecisionKindRoomCreation, DecisionAnswerCommand{Decision: "approve"}, "succeeded"},
		{DecisionKindRoomCreation, DecisionAnswerCommand{Decision: "deny", Comment: "Use the existing Room."}, "denied"},
		{DecisionKindRoomCreation, DecisionAnswerCommand{Decision: "deny"}, ""},
		{DecisionKindRoomCreation, DecisionAnswerCommand{Decision: "approve", Comment: "ok"}, ""},
		{DecisionKindConnectorWrite, DecisionAnswerCommand{Decision: "approve", ConnectionID: "connection_notion"}, ""},
	} {
		answer, status, err := normalizeDecisionAnswer(test.kind, nil, test.command)
		if test.status == "" {
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("%s %+v: err=%v, want ErrInvalid", test.kind, test.command, err)
			}
			continue
		}
		if err != nil || status != test.status || answer.Decision != test.command.Decision || answer.ConnectionID != test.command.ConnectionID {
			t.Fatalf("%s %+v: answer=%+v status=%q err=%v", test.kind, test.command, answer, status, err)
		}
	}
}

// A Room Agent reads a connection result as the payload it always read; a
// delegated Task's AlterEgo reads what to do next.
func TestConnectionNoticesTellRoomAgentsAndAlterEgos(t *testing.T) {
	t.Parallel()
	view, _ := json.Marshal(connectionView{Prompt: "Connect Notion", AppKey: "notion"})
	anyApp, _ := json.Marshal(connectionView{Prompt: "Add a key"})
	chrome, _ := json.Marshal(connectionView{Prompt: "Connect Chrome", ComputerID: "computer-1"})
	permission, _ := json.Marshal(computerPermissionView{ComputerID: "computer-1", Subject: "linger", Permissions: []string{"screen_recording"}})
	task := pgtype.Text{String: "task_1", Valid: true}
	for _, test := range []struct {
		kind, status, answer string
		view                 []byte
		alterEgo             pgtype.Text
		want                 string
	}{
		{DecisionKindConnectionAuth, "succeeded", `{"decision":"approve","connection_id":"connection_1"}`, view, pgtype.Text{},
			`Human interaction decision_1 payload={"decision":"approve","connection_id":"connection_1"}`},
		{DecisionKindConnectionAuth, "denied", `{"decision":"deny"}`, view, pgtype.Text{}, `Human interaction decision_1 payload={"decision":"deny"}`},
		{DecisionKindConnectionAuth, "expired", "", view, pgtype.Text{},
			`Human interaction decision_1 payload={"decision":"deny","comment":"Connection authorization expired"}`},
		{DecisionKindConnectionAuth, "succeeded", `{"decision":"approve","connection_id":"connection_1"}`, view, task,
			"The Sponsor connected notion. Run the command that needed it again."},
		{DecisionKindConnectionAuth, "failed", `{"decision":"approve","connection_id":"connection_1"}`, view, task,
			"The notion connection was not completed (failed). Commands that need it still fail; continue without it and say so in your final reply.\nConnection authorization failed"},
		{DecisionKindProviderKey, "answered", `{"decision":"configured"}`, view, pgtype.Text{},
			"Human interaction decision_1 resolved: the user added the Composio API key. Run the command that needed notion again"},
		{DecisionKindProviderKey, "answered", `{"decision":"configured"}`, anyApp, pgtype.Text{},
			"the user added the Composio API key. Run the command that needed it again; it asks to connect the app"},
		{DecisionKindProviderKey, "denied", `{"decision":"deny"}`, view, pgtype.Text{}, "did not add the Composio API key, so every connected app stays unavailable"},
		{DecisionKindProviderKey, "answered", `{"decision":"configured"}`, view, task, "The Sponsor added the Composio API key. Run the command that needed notion again"},
		{DecisionKindBrowserConnection, "answered", `{"decision":"connected"}`, chrome, pgtype.Text{}, "the user connected their everyday Chrome"},
		{DecisionKindBrowserConnection, "denied", `{"decision":"deny"}`, chrome, pgtype.Text{}, "declined to connect their everyday Chrome"},
		{DecisionKindBrowserConnection, "answered", `{"decision":"connected"}`, chrome, task, ""},
		{DecisionKindComputerPermission, "answered", `{"decision":"granted"}`, permission, pgtype.Text{},
			"Human interaction decision_1 resolved: the user granted screen_recording for Linger. Continue the task now."},
		{DecisionKindComputerPermission, "answered", `{"decision":"granted"}`, permission, task, "the user granted screen_recording for Linger"},
		{DecisionKindComputerPermission, "denied", `{"decision":"deny"}`, permission, pgtype.Text{}, "declined to grant screen_recording for Linger"},
		{DecisionKindComputerPermission, "expired", "", permission, task, "was not granted"},
	} {
		decision := decisionRecord{Kind: test.kind, Status: test.status, View: test.view, AlterEgoTaskID: test.alterEgo}
		if test.answer != "" {
			decision.Answer = []byte(test.answer)
		}
		text, err := decisionNoticeText("decision_1", decision)
		if err != nil || test.want == "" && text != "" || test.want != "" && !strings.Contains(text, test.want) {
			t.Fatalf("%s %s: text=%q err=%v", test.kind, test.status, text, err)
		}
	}
}

func TestEncodeDecisionCardShowsConnectionAndRoomViews(t *testing.T) {
	t.Parallel()
	decider := store.Actor{ID: "actor_alice", Kind: "human", DisplayName: "Alice"}
	member := store.Actor{ID: "actor_bob", Kind: "human", DisplayName: "Bob"}
	requester := store.Actor{ID: "actor_nova", Kind: "agent", DisplayName: "Nova"}
	record := store.MessageCard{CardType: "personal_notice", Intent: "decision_requested", Version: 2}
	decided := pgtype.Timestamptz{Time: time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC), Valid: true}
	connection, _ := json.Marshal(connectionView{Prompt: "Connect Notion", AppKey: "notion"})
	room, _ := json.Marshal(roomCreationProposal{OriginRoomID: "room_origin", Name: "Audit", MemberIDs: []string{"actor_alice"}})
	permission, _ := json.Marshal(computerPermissionView{ComputerID: "computer-1", Subject: "linger", Permissions: []string{"screen_recording"}})
	for _, test := range []struct {
		decision  decisionRecord
		decidedBy *store.Actor
		check     func(map[string]any) bool
	}{
		{decisionRecord{ID: "decision_c", Kind: DecisionKindConnectionAuth, Status: "authorizing", View: connection,
			Answer: []byte(`{"decision":"approve","connection_id":"connection_1"}`), DecidedAt: decided}, &decider,
			func(card map[string]any) bool {
				view := card["connection_auth"].(map[string]any)
				return card["title"] == "Connect Notion" && view["app_key"] == "notion" && view["connection_id"] == "connection_1"
			}},
		{decisionRecord{ID: "decision_k", Kind: DecisionKindProviderKey, Status: "pending", View: connection}, nil,
			func(card map[string]any) bool {
				view := card["provider_key"].(map[string]any)
				return card["title"] == "Connect Notion" && view["app_key"] == "notion" && card["connection_auth"] == nil
			}},
		{decisionRecord{ID: "decision_r", Kind: DecisionKindRoomCreation, Status: "succeeded", View: room,
			Answer: []byte(`{"decision":"approve"}`), Result: []byte(`{"outcome":"","data":{"created_room_id":"room_new"}}`), DecidedAt: decided},
			&member, func(card map[string]any) bool {
				view := card["room_creation"].(map[string]any)
				return card["title"] == "Request to create a collaboration room: Audit" && view["created_room_id"] == "room_new" &&
					view["name"] == "Audit" && card["decided_by"].(map[string]any)["id"] == "actor_bob"
			}},
		{decisionRecord{ID: "decision_p", Kind: DecisionKindComputerPermission, Status: "answered", View: permission,
			Answer: []byte(`{"decision":"granted"}`), DecidedAt: decided}, &decider,
			func(card map[string]any) bool {
				view := card["computer_permission"].(map[string]any)
				return card["title"] == computerPermissionTitle && view["computer_id"] == "computer-1" && view["subject"] == "linger" &&
					card["answer"].(map[string]any)["decision"] == "granted"
			}},
	} {
		encoded, err := encodeDecisionCard(record, decider, requester, test.decidedBy, test.decision)
		if err != nil {
			t.Fatal(err)
		}
		var card map[string]any
		if err := json.Unmarshal(encoded, &card); err != nil {
			t.Fatal(err)
		}
		if !test.check(card) {
			t.Fatalf("%s card %s", test.decision.Kind, encoded)
		}
	}
}
