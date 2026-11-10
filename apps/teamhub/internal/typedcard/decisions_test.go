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

func TestDecisionCommandNamesExactlyOneValidKind(t *testing.T) {
	t.Parallel()
	write := &ConnectorWriteDecision{View: ConnectorWriteView{Title: "Send an email"}}
	create := &AgentChangeDecision{View: AgentChangeView{Action: "create", AgentName: "Researcher",
		Changes: []AgentChange{{Field: "name", After: "Researcher"}}}}
	update := &AgentChangeDecision{Request: AgentChangeRequest{TargetActorID: "actor_nova"},
		View: AgentChangeView{Action: "update", AgentName: "Nova", Changes: []AgentChange{{Field: "name", After: "Nova Prime"}}}}
	question := &QuestionDecision{Prompt: " Pick a day ", Questions: []DecisionQuestion{{ID: "q1", Prompt: "Which day?", Input: "radio", Options: []DecisionQuestionOption{{ID: "o1", Label: "Friday"}}}}}
	permission := &RuntimePermissionDecision{ContextKey: "context", ActionDigest: "sha256:digest", Runtime: []byte(`{"kind":"permission"}`),
		Card: RuntimePermissionCard{Title: "Run rm -rf build"}}
	for name, test := range map[string]struct {
		command DecisionCommand
		kind    string
		text    string
	}{
		"connector write":             {command: DecisionCommand{ConnectorWrite: write}, kind: DecisionKindConnectorWrite, text: "Approval needed: Send an email"},
		"agent create":                {command: DecisionCommand{AgentChange: create}, kind: DecisionKindAgentChange, text: "Approval needed: Create Agent “Researcher”"},
		"agent update":                {command: DecisionCommand{AgentChange: update}, kind: DecisionKindAgentChange, text: "Approval needed: Change Agent “Nova”"},
		"question":                    {command: DecisionCommand{Question: question}, kind: DecisionKindQuestion, text: "Pick a day"},
		"runtime permission":          {command: DecisionCommand{RuntimePermission: permission}, kind: DecisionKindRuntimePermission, text: "Approval needed: Run rm -rf build"},
		"question without questions":  {command: DecisionCommand{Question: &QuestionDecision{Prompt: "Pick"}}},
		"permission without a digest": {command: DecisionCommand{RuntimePermission: &RuntimePermissionDecision{ContextKey: "context", Runtime: []byte(`{}`), Card: permission.Card}}},
		"no kind":                     {},
		"two kinds":                   {command: DecisionCommand{ConnectorWrite: write, AgentChange: create}},
		"update without its target":   {command: DecisionCommand{AgentChange: &AgentChangeDecision{View: update.View}}},
		"create naming a target":      {command: DecisionCommand{AgentChange: &AgentChangeDecision{Request: update.Request, View: create.View}}},
		"agent change with no change": {command: DecisionCommand{AgentChange: &AgentChangeDecision{View: AgentChangeView{Action: "create", AgentName: "x"}}}},
	} {
		draft, err := test.command.draft()
		if test.kind == "" {
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("%s: err=%v, want ErrInvalid", name, err)
			}
			continue
		}
		if err != nil || draft.kind != test.kind || draft.text != test.text {
			t.Fatalf("%s: kind=%q text=%q err=%v", name, draft.kind, draft.text, err)
		}
	}
}

func TestEncodeDecisionCardShowsTheKindsViewAndTheAnswer(t *testing.T) {
	t.Parallel()
	decider := store.Actor{ID: "actor_alice", Kind: "human", DisplayName: "Alice"}
	requester := store.Actor{ID: "actor_nova", Kind: "agent", DisplayName: "Nova"}
	record := store.MessageCard{CardType: "personal_notice", Intent: "decision_requested", Version: 2}
	expires := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	view, _ := json.Marshal(ConnectorWriteView{Kind: "message", App: "gmail", Title: "Send an email", Tool: "GMAIL_SEND_EMAIL", Input: "{}"})
	decision := decisionRecord{
		ID: "decision_1", Kind: DecisionKindConnectorWrite, Status: "unknown", View: view,
		Answer: []byte(`{"decision":"approve"}`), Result: []byte(`{"outcome":"It may have taken effect."}`),
		ExpiresAt: pgtype.Timestamptz{Time: expires, Valid: true}, DecidedAt: pgtype.Timestamptz{Time: expires.Add(-time.Hour), Valid: true},
	}
	encoded, err := encodeDecisionCard(record, decider, requester, &decider, decision)
	if err != nil {
		t.Fatal(err)
	}
	var card map[string]any
	if err := json.Unmarshal(encoded, &card); err != nil {
		t.Fatal(err)
	}
	if card["title"] != "Send an email" || card["status"] != "unknown" || card["outcome"] != "It may have taken effect." ||
		card["decision_id"] != "decision_1" || card["connector_write"] == nil || card["agent_change"] != nil ||
		card["decided_by"] == nil || card["answer"].(map[string]any)["decision"] != "approve" {
		t.Fatalf("decided connector card %s", encoded)
	}

	agentView, _ := json.Marshal(AgentChangeView{Action: "create", AgentName: "Researcher", Changes: []AgentChange{{Field: "name", After: "Researcher"}}})
	pending := decisionRecord{ID: "decision_2", Kind: DecisionKindAgentChange, Status: "pending", View: agentView,
		ExpiresAt: pgtype.Timestamptz{Time: expires, Valid: true}}
	encoded, err = encodeDecisionCard(record, decider, requester, nil, pending)
	if err != nil {
		t.Fatal(err)
	}
	card = nil
	if err := json.Unmarshal(encoded, &card); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"answer", "decided_by", "decided_at", "outcome", "connector_write"} {
		if _, found := card[key]; found {
			t.Fatalf("pending Agent change card carries %s: %s", key, encoded)
		}
	}
	if card["title"] != "Create Agent “Researcher”" || card["agent_change"] == nil {
		t.Fatalf("pending Agent change card %s", encoded)
	}
}

func TestDecisionNoticeTellsTheAgentHowEachKindEnded(t *testing.T) {
	t.Parallel()
	connectorView, _ := json.Marshal(ConnectorWriteView{Title: "Send an email"})
	agentView, _ := json.Marshal(AgentChangeView{Action: "create", AgentName: "Researcher"})
	permissionView, _ := json.Marshal(RuntimePermissionCard{Title: "Run make"})
	questionView, _ := json.Marshal(openingView{Prompt: "Plans", Questions: []DecisionQuestion{
		{ID: "q1", Prompt: "What else?", Input: "checkbox", Options: []DecisionQuestionOption{{ID: "o1", Label: "KTV"}, {ID: "o2", Label: "Board games"}}},
	}})
	for _, test := range []struct {
		kind, status string
		view         []byte
		answer       string
		result       string
		want         string
	}{
		{DecisionKindConnectorWrite, "succeeded", connectorView, "", `{"outcome":"","data":{"id":"sent-1"}}`, `TeamHub ran it.` + "\n" + `Result: {"id":"sent-1"}`},
		{DecisionKindConnectorWrite, "failed", connectorView, "", `{"outcome":"The account is not active."}`, "it did not run: The account is not active."},
		{DecisionKindConnectorWrite, "unknown", connectorView, "", `{"outcome":"It may have taken effect."}`, "its result is unknown"},
		{DecisionKindConnectorWrite, "denied", connectorView, `{"decision":"deny","comment":"Wrong recipient"}`, "", "Reason: Wrong recipient"},
		{DecisionKindConnectorWrite, "expired", connectorView, "", "", "before the card expired"},
		{DecisionKindAgentChange, "succeeded", agentView, "", `{"outcome":"","data":{"actor_id":"actor_new"}}`, "created the Agent (actor_id actor_new)"},
		{DecisionKindAgentChange, "denied", agentView, `{"decision":"deny"}`, "", "Do not try to achieve the same effect another way."},
		{DecisionKindAgentChange, "expired", agentView, "", "", "nobody approved it within 24 hours"},
		{DecisionKindRuntimePermission, "approved", permissionView, `{"decision":"approve"}`, "", "Approval decision_1 was granted: Run make\nRetry that call once"},
		{DecisionKindRuntimePermission, "denied", permissionView, `{"decision":"deny","comment":"Not now"}`, "", "Approval decision_1 was denied: Run make\nReason: Not now"},
		{DecisionKindRuntimePermission, "expired", permissionView, "", "", "Approval decision_1 expired: Run make"},
		{DecisionKindQuestion, "answered", questionView, `{"decision":"submit","answers":{"q1":["o2","Karaoke"]},"comment":"Soon"}`, "",
			"Human interaction decision_1 answered:\n- What else? → Board games, Karaoke\nComment: Soon"},
	} {
		decision := decisionRecord{Kind: test.kind, Status: test.status, View: test.view}
		if test.answer != "" {
			decision.Answer = []byte(test.answer)
		}
		if test.result != "" {
			decision.Result = []byte(test.result)
		}
		text, err := decisionNoticeText("decision_1", decision)
		if err != nil || !strings.Contains(text, "decision_1") || !strings.Contains(text, test.want) {
			t.Fatalf("%s %s: text=%q err=%v", test.kind, test.status, text, err)
		}
	}
}

// Nobody waits on the notice of an AnotherMe setup card or of a native
// question whose Run ended.
func TestDecisionNoticeIsEmptyWhenNobodyWaits(t *testing.T) {
	t.Parallel()
	view, _ := json.Marshal(openingView{Prompt: "Plans", Questions: []DecisionQuestion{{ID: "q1", Prompt: "Which day?", Input: "radio", Options: []DecisionQuestionOption{{ID: "o1", Label: "Friday"}}}}})
	for _, decision := range []decisionRecord{
		{Kind: DecisionKindQuestion, Status: "expired", View: view},
		{Kind: DecisionKindProfileSetupApps, Status: "answered", View: view, Answer: []byte(`{"decision":"connected"}`)},
		{Kind: DecisionKindProfileSetupSources, Status: "answered", View: view, Answer: []byte(`{"decision":"skipped"}`)},
	} {
		if text, err := decisionNoticeText("decision_1", decision); err != nil || text != "" {
			t.Fatalf("%s %s: text=%q err=%v", decision.Kind, decision.Status, text, err)
		}
	}
}

func TestEncodeDecisionCardShowsQuestionPermissionAndSetupViews(t *testing.T) {
	t.Parallel()
	decider := store.Actor{ID: "actor_alice", Kind: "human", DisplayName: "Alice"}
	requester := store.Actor{ID: "actor_nova", Kind: "agent", DisplayName: "Nova"}
	record := store.MessageCard{CardType: "personal_notice", Intent: "decision_requested", Version: 1}
	question, _ := json.Marshal(openingView{Prompt: "Getting started", Questions: []DecisionQuestion{{ID: "q1", Prompt: "Which day?", Input: "radio", Options: []DecisionQuestionOption{{ID: "o1", Label: "Friday"}}}}})
	permission, _ := json.Marshal(RuntimePermissionCard{Kind: "gui", Title: "Click Send", Tool: "computer", Input: "{}",
		Screenshot: &RuntimePermissionScreenshot{Width: 640, Height: 480}})
	apps, _ := json.Marshal(openingView{Prompt: ProfileSetupAppsPrompt, Apps: []string{"gmail"}, MoreApps: []string{"notion"}})
	approval := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		decision decisionRecord
		check    func(card map[string]any) bool
	}{
		{decisionRecord{ID: "decision_q", Kind: DecisionKindQuestion, Status: "pending", View: question}, func(card map[string]any) bool {
			questions := card["question"].(map[string]any)["questions"].([]any)
			_, expires := card["expires_at"]
			return card["title"] == "Getting started" && len(questions) == 1 && !expires
		}},
		{decisionRecord{ID: "decision_p", Kind: DecisionKindRuntimePermission, Status: "approved", View: permission,
			Answer: []byte(`{"decision":"approve"}`), ExpiresAt: pgtype.Timestamptz{Time: approval, Valid: true},
			DecidedAt: pgtype.Timestamptz{Time: approval.Add(-time.Hour), Valid: true}}, func(card map[string]any) bool {
			view := card["runtime_permission"].(map[string]any)
			return card["title"] == "Click Send" && view["screenshot"].(map[string]any)["url"] == "/v0/decisions/decision_p/screenshot" &&
				card["expires_at"] == "2026-11-05T09:00:00Z"
		}},
		{decisionRecord{ID: "decision_a", Kind: DecisionKindProfileSetupApps, Status: "pending", View: apps}, func(card map[string]any) bool {
			view := card["profile_setup"].(map[string]any)
			return card["title"] == ProfileSetupAppsPrompt && len(view["apps"].([]any)) == 1 && len(view["more_apps"].([]any)) == 1
		}},
	} {
		encoded, err := encodeDecisionCard(record, decider, requester, &decider, test.decision)
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

func TestNormalizeDecisionAnswerTakesWhatEachKindAsks(t *testing.T) {
	t.Parallel()
	questions, _ := json.Marshal(questionView{Prompt: "Plans", Questions: []DecisionQuestion{
		{ID: "q1", Prompt: "Where?", Input: "radio", Options: []DecisionQuestionOption{{ID: "o1", Label: "Hotpot"}}},
		{ID: "q2", Prompt: "What else?", Input: "checkbox", Options: []DecisionQuestionOption{{ID: "o1", Label: "KTV"}}},
	}})
	answer, status, err := normalizeDecisionAnswer(DecisionKindQuestion, questions, DecisionAnswerCommand{
		Decision: "submit", Comment: " Soon ", Answers: map[string]any{"q1": " Dumplings ", "q2": []any{"o1", " Karaoke "}},
	})
	if err != nil || status != "answered" || answer.Answers["q1"] != "Dumplings" || answer.Comment != "Soon" ||
		strings.Join(answer.Answers["q2"].([]string), ",") != "o1,Karaoke" {
		t.Fatalf("question answer=%+v status=%s err=%v", answer, status, err)
	}
	if _, status, err := normalizeDecisionAnswer(DecisionKindRuntimePermission, nil, DecisionAnswerCommand{Decision: "approve"}); err != nil || status != "approved" {
		t.Fatalf("permission approve status=%s err=%v", status, err)
	}
	if answer, status, err := normalizeDecisionAnswer(DecisionKindProfileSetupApps, nil, DecisionAnswerCommand{Decision: "skipped"}); err != nil || status != "answered" || answer.Decision != "skipped" {
		t.Fatalf("apps answer=%+v status=%s err=%v", answer, status, err)
	}
	sources, _, err := normalizeDecisionAnswer(DecisionKindProfileSetupSources, nil, DecisionAnswerCommand{
		Decision: "done", Links: []string{" https://a.example ", "http://b.example/x", "https://a.example"}, AttachmentUploadIDs: []string{"upload_a"},
	})
	if err != nil || strings.Join(sources.Links, ",") != "https://a.example,http://b.example/x" || len(sources.AttachmentUploadIDs) != 1 {
		t.Fatalf("sources answer=%+v err=%v", sources, err)
	}
	for name, test := range map[string]struct {
		kind    string
		command DecisionAnswerCommand
	}{
		"question without answers":    {DecisionKindQuestion, DecisionAnswerCommand{Decision: "submit"}},
		"question blank radio":        {DecisionKindQuestion, DecisionAnswerCommand{Decision: "submit", Answers: map[string]any{"q1": " ", "q2": []string{"o1"}}}},
		"question duplicate checked":  {DecisionKindQuestion, DecisionAnswerCommand{Decision: "submit", Answers: map[string]any{"q1": "o1", "q2": []string{"o1", "o1"}}}},
		"question long checkbox":      {DecisionKindQuestion, DecisionAnswerCommand{Decision: "submit", Answers: map[string]any{"q1": "o1", "q2": []string{strings.Repeat("a", 201)}}}},
		"question approved":           {DecisionKindQuestion, DecisionAnswerCommand{Decision: "approve"}},
		"approval with a reason":      {DecisionKindRuntimePermission, DecisionAnswerCommand{Decision: "approve", Comment: "fine"}},
		"permission with answers":     {DecisionKindRuntimePermission, DecisionAnswerCommand{Decision: "deny", Answers: map[string]any{"q1": "x"}}},
		"connector with links":        {DecisionKindConnectorWrite, DecisionAnswerCommand{Decision: "approve", Links: []string{"https://a.example"}}},
		"apps done":                   {DecisionKindProfileSetupApps, DecisionAnswerCommand{Decision: "done"}},
		"apps with links":             {DecisionKindProfileSetupApps, DecisionAnswerCommand{Decision: "connected", Links: []string{"https://a.example"}}},
		"sources connected":           {DecisionKindProfileSetupSources, DecisionAnswerCommand{Decision: "connected"}},
		"sources bare host":           {DecisionKindProfileSetupSources, DecisionAnswerCommand{Decision: "done", Links: []string{"a.example"}}},
		"sources script link":         {DecisionKindProfileSetupSources, DecisionAnswerCommand{Decision: "done", Links: []string{"javascript:alert(1)"}}},
		"sources link with a space":   {DecisionKindProfileSetupSources, DecisionAnswerCommand{Decision: "done", Links: []string{"https://a.example/x y"}}},
		"sources long link":           {DecisionKindProfileSetupSources, DecisionAnswerCommand{Decision: "done", Links: []string{"https://a.example/" + strings.Repeat("a", 2048)}}},
		"sources six links":           {DecisionKindProfileSetupSources, DecisionAnswerCommand{Decision: "done", Links: []string{"https://a/1", "https://a/2", "https://a/3", "https://a/4", "https://a/5", "https://a/6"}}},
		"sources six uploads":         {DecisionKindProfileSetupSources, DecisionAnswerCommand{Decision: "done", AttachmentUploadIDs: []string{"a", "b", "c", "d", "e", "f"}}},
		"sources duplicate uploads":   {DecisionKindProfileSetupSources, DecisionAnswerCommand{Decision: "done", AttachmentUploadIDs: []string{"a", "a"}}},
		"sources skipped with links":  {DecisionKindProfileSetupSources, DecisionAnswerCommand{Decision: "skipped", Links: []string{"https://a.example"}}},
		"sources skipped with upload": {DecisionKindProfileSetupSources, DecisionAnswerCommand{Decision: "skipped", AttachmentUploadIDs: []string{"a"}}},
	} {
		if _, _, err := normalizeDecisionAnswer(test.kind, questions, test.command); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s: err=%v want ErrInvalid", name, err)
		}
	}
}

func TestOpeningDecisionsAreQuestionsOrSetupCards(t *testing.T) {
	t.Parallel()
	apps := ProfileSetupAppsOpening()
	view, err := normalizeOpening(apps)
	if err != nil || strings.Join(view.Apps, ",") != "gmail,outlook,google_calendar" || strings.Join(view.MoreApps, ",") != "github,notion" {
		t.Fatalf("apps opening=%+v err=%v", view, err)
	}
	if _, err := normalizeOpening(OpeningDecision{Kind: DecisionKindProfileSetupSources, Prompt: profileSetupSourcesPrompt}); err != nil {
		t.Fatalf("sources opening err=%v", err)
	}
	for _, invalid := range []OpeningDecision{
		{Kind: DecisionKindQuestion, Prompt: "Getting started"},
		{Kind: DecisionKindProfileSetupApps, Prompt: "Apps"},
		{Kind: DecisionKindProfileSetupSources, Prompt: "Sources", Apps: []string{"gmail"}},
		{Kind: DecisionKindRuntimePermission, Prompt: "Approve"},
		{Kind: DecisionKindQuestion, Prompt: " ", Questions: []DecisionQuestion{{ID: "q1", Prompt: "Which day?", Input: "radio", Options: []DecisionQuestionOption{{ID: "o1", Label: "Friday"}}}}},
	} {
		if _, err := normalizeOpening(invalid); !errors.Is(err, ErrInvalid) {
			t.Fatalf("opening %+v err=%v want ErrInvalid", invalid, err)
		}
	}
}

func TestNormalizeQuestionsRejectsBrokenQuestions(t *testing.T) {
	t.Parallel()
	for name, questions := range map[string][]DecisionQuestion{
		"none":              nil,
		"radio no options":  {{ID: "q1", Prompt: "Which?", Input: "radio"}},
		"text input":        {{ID: "q1", Prompt: "Which?", Input: "text"}},
		"duplicate ids":     {{ID: "q1", Prompt: "A?", Input: "radio", Options: []DecisionQuestionOption{{ID: "o1", Label: "Friday"}}}, {ID: "q1", Prompt: "B?", Input: "radio", Options: []DecisionQuestionOption{{ID: "o1", Label: "Friday"}}}},
		"duplicate options": {{ID: "q1", Prompt: "A?", Input: "radio", Options: []DecisionQuestionOption{{ID: "o1", Label: "A"}, {ID: "o1", Label: "B"}}}},
		"unknown input":     {{ID: "q1", Prompt: "A?", Input: "slider"}},
	} {
		if _, err := normalizeQuestions(questions); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s: err=%v want ErrInvalid", name, err)
		}
	}
}
