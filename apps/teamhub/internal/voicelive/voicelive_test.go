package voicelive

import (
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func TestRecentHistoryPreservesUnansweredAndConsecutiveMessages(t *testing.T) {
	newest := []HistoryMessage{{Role: "user", Text: "Not answered yet"}, {Role: "user", Text: "One more thing"}, {Role: "assistant", Text: "Opening line"}}
	want := []HistoryMessage{newest[2], newest[1], newest[0]}
	if got := recentHistory(newest); !reflect.DeepEqual(got, want) {
		t.Fatalf("history=%#v", got)
	}
}
func TestRecentHistoryKeepsTwentyMessages(t *testing.T) {
	var newest []HistoryMessage
	for i := 0; i < 30; i++ {
		newest = append(newest, HistoryMessage{Role: "user", Text: strings.Repeat("x", i+1)})
	}
	got := recentHistory(newest)
	if len(got) != 20 || len(got[0].Text) != 20 || got[19].Text != "x" {
		t.Fatalf("history=%#v", got)
	}
}

func TestToolCatalogMatchesContract(t *testing.T) {
	namePattern := regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	// The most a session is served: every tool, the browser and the app tools.
	served := slices.Concat(Tools, []Tool{BrowserTool}, AppTools)
	if len(Tools) == 0 || len(served) > 64 {
		t.Fatalf("tool catalog size %d", len(served))
	}
	seen := map[string]bool{}
	for _, tool := range served {
		if !namePattern.MatchString(tool.Name) || seen[tool.Name] || tool.Description == "" || len(tool.Description) > 2000 {
			t.Fatalf("invalid tool %q", tool.Name)
		}
		seen[tool.Name] = true
		if _, err := json.Marshal(tool.Parameters); err != nil || tool.Parameters["type"] != "object" {
			t.Fatalf("tool %q parameters are not a JSON Schema object", tool.Name)
		}
	}
	writes := []string{ToolSendMessage, ToolAppendPocketNote, ToolDeletePocketNote, ToolCreateRoom, ToolCreateRoutine, ToolCreateAgent, ToolSendSlack, ToolDecideApproval}
	for _, tool := range served {
		if !slices.Contains(writes, tool.Name) {
			continue
		}
		required := tool.Parameters["required"].([]string)
		if !strings.Contains(strings.Join(required, ","), "confirmed") {
			t.Fatalf("write tool %q must require confirmed", tool.Name)
		}
	}
	for _, name := range writes {
		if !seen[name] {
			t.Fatalf("write tool %q is missing", name)
		}
	}
}

func TestDecodeArgumentsAcceptsEmptyAndRejectsMalformed(t *testing.T) {
	var args SendMessageArguments
	if err := DecodeArguments("", &args); err != nil || args.Confirmed {
		t.Fatalf("empty arguments: %v %+v", err, args)
	}
	if err := DecodeArguments(`{"text":"hi","confirmed":true}`, &args); err != nil || !args.Confirmed || args.Text != "hi" {
		t.Fatalf("arguments: %v %+v", err, args)
	}
	if err := DecodeArguments(`{"text":`, &args); !errors.Is(err, ErrInvalid) {
		t.Fatalf("malformed arguments error=%v", err)
	}
	if !strings.HasPrefix(NeedsConfirmation("x"), `{"next":"Ask the user this now`) || !strings.Contains(NeedsConfirmation("x"), `"status":"needs_confirmation","summary":"x"}`) ||
		ErrorOutput("unknown_tool") != `{"error":"unknown_tool"}` {
		t.Fatal("unexpected tool output encoding")
	}
}

func TestAppendPocketNoteToolIsAConfirmedWrite(t *testing.T) {
	for _, tool := range Tools {
		if tool.Name != ToolAppendPocketNote {
			continue
		}
		required, _ := tool.Parameters["required"].([]string)
		if strings.Join(required, ",") != "text,confirmed" {
			t.Fatalf("required = %v", required)
		}
		var args AppendPocketNoteArguments
		if err := DecodeArguments(`{"text":"Dinner at West Lake","time":"8 pm tonight","confirmed":true}`, &args); err != nil || !args.Confirmed || args.Time != "8 pm tonight" {
			t.Fatalf("args = %+v, err = %v", args, err)
		}
		return
	}
	t.Fatal("append_pocket_note is not offered")
}

func TestConfirmedAcceptsStringBooleans(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"text":"a","confirmed":"True"}`: true, `{"text":"a","confirmed":"true"}`: true,
		`{"text":"a","confirmed":true}`: true, `{"text":"a","confirmed":"False"}`: false, `{"text":"a"}`: false,
	} {
		var note AppendPocketNoteArguments
		var send SendMessageArguments
		if DecodeArguments(raw, &note) != nil || DecodeArguments(raw, &send) != nil || bool(note.Confirmed) != want || bool(send.Confirmed) != want {
			t.Fatalf("%s: note=%v send=%v want %v", raw, note.Confirmed, send.Confirmed, want)
		}
	}
}

func TestRecallMemoryToolIsARead(t *testing.T) {
	for _, tool := range Tools {
		if tool.Name != ToolRecallMemory {
			continue
		}
		if required := tool.Parameters["required"].([]string); !reflect.DeepEqual(required, []string{"query"}) {
			t.Fatalf("recall_memory required = %v", required)
		}
		return
	}
	t.Fatal("recall_memory is missing")
}

func TestCompactRecallKeepsFourBulletsSourcesAndOpenableRoom(t *testing.T) {
	var response RecallMemoryResponse
	raw := `{"status":"grounded","facts":[
		{"text":"We set the Q3 budget cap at 500k","mentionedAt":"2026-09-01T02:00:00Z","evidenceId":"raw_a"},
		{"text":"We set the Q3 budget cap at 500k","mentionedAt":"2026-09-01T02:00:00Z","evidenceId":"raw_a"},
		{"text":"I will align with finance","mentionedAt":"2026-09-01T02:00:00Z","evidenceId":"raw_a"},
		{"text":"Give the breakdown by next Monday","mentionedAt":"2026-09-01T02:00:00Z","evidenceId":"raw_a"},
		{"text":"A fourth fact must not crowd out the source","mentionedAt":"2026-09-01T02:00:00Z","evidenceId":"raw_a"}],
	"items":[
		{"title":"Budget meeting","excerpt":"` + strings.Repeat("x", 400) + `","timeHint":"2026-09-01","source":{"label":"Budget group"},
		 "metadata":{"sourceUri":"teamhub://rooms/room-budget/messages"}},
		{"title":"Someone else's Room","excerpt":"Must not give a room_id","timeHint":"2026-08-30","source":{"label":"Someone else's group"},
		 "metadata":{"sourceUri":"teamhub://rooms/room-hidden/messages"}},
		{"title":"Meeting notes","excerpt":"Notes","source":{"label":"Notes document"},
		 "metadata":{"sourceUri":"teamhub://documents/doc-1/versions/v1"}},
		{"title":"Fourth source","excerpt":"x","source":{"label":"Fourth"},"metadata":{}}]}`
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		t.Fatal(err)
	}
	result := CompactRecall(RecallEvidence{Raw: response}, func(roomID string) (string, bool) {
		return "Budget group", roomID == "room-budget"
	})
	bullets := result["bullets"].([]string)
	if len(bullets) != 4 || bullets[0] != "We set the Q3 budget cap at 500k" || bullets[1] != "I will align with finance" ||
		bullets[2] != "Give the breakdown by next Monday" || len([]rune(bullets[3])) != recallBulletRunes {
		t.Fatalf("bullets = %#v", bullets)
	}
	sources := result["sources"].([]map[string]string)
	if len(sources) != 3 || sources[0]["room_id"] != "room-budget" || sources[0]["date"] != "2026-09-01" ||
		sources[1]["room_id"] != "" || sources[2]["title"] != "Notes document" {
		t.Fatalf("sources = %#v", sources)
	}
	if result["status"] != "found" || result["openable_room_id"] != "room-budget" || result["openable_room"] != "Budget group" {
		t.Fatalf("result = %#v", result)
	}
	empty := CompactRecall(RecallEvidence{}, nil)
	if empty["status"] != "empty" || empty["openable_room_id"] != nil {
		t.Fatalf("empty = %#v", empty)
	}
}

func TestSpokenRecallTextDropsMarkupAndTimestamps(t *testing.T) {
	got := spokenRecallText("## 2026-08-25T02:03:59.000Z · Ray Zhao can you hear me? Mia Chen 00:37:01.710\\ right, **plan** cost.<br>OK")
	if got != "Ray Zhao can you hear me? Mia Chen right, plan cost. OK" {
		t.Fatalf("got %q", got)
	}
}

func TestNamedPeopleFindsDirectoryNamesInTheQuery(t *testing.T) {
	directory := []string{"Ray Zhao", "Mia Chen", "Alice", "B", "Max Wang", "Mia Chen"}
	if got := NamedPeople("What did Mia Chen and Max Wang say", directory); !reflect.DeepEqual(got, []string{"Mia Chen", "Max Wang"}) {
		t.Fatalf("got %v", got)
	}
	if got := NamedPeople("What did Bo say", directory); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestCompactRecallPrefersEvidenceNamingThePerson(t *testing.T) {
	var evidence RecallEvidence
	// A published Wiki page is one more indexed source beside the Room text.
	if err := json.Unmarshal([]byte(`{"items":[
		{"title":"2026-08-25 Shisuo and Jieli hardware discussion","content":"Action Items: Ray Zhao follow up on the Jieli quote","timeHint":"2026-08-25",
		 "source":{"kind":"wiki","label":"2026-08-25 Shisuo and Jieli hardware discussion"},"metadata":{}},
		{"title":"GTM document","excerpt":"ICP inference benchmark","source":{"label":"icp.md"},"metadata":{}},
		{"title":"Hardware discussion","excerpt":"Ray Zhao: hold on, nudge him again.","timeHint":"2026-08-25","source":{"label":"Hardware discussion group"},
		 "metadata":{"sourceUri":"teamhub://rooms/room-hw/messages"}}]}`), &evidence.Raw); err != nil {
		t.Fatal(err)
	}
	evidence.Entities = []string{"Ray Zhao"}
	if !RecallMentions(evidence) {
		t.Fatal("expected a mention")
	}
	result := CompactRecall(evidence, func(string) (string, bool) { return "Hardware discussion group", true })
	bullets := result["bullets"].([]string)
	if result["status"] != "found" || len(bullets) != 2 || !strings.Contains(bullets[0], "follow up on the Jieli quote") || strings.Contains(strings.Join(bullets, ""), "ICP") {
		t.Fatalf("result = %#v", result)
	}
	sources := result["sources"].([]map[string]string)
	if sources[0]["date"] != "2026-08-25" || result["openable_room_id"] != "room-hw" {
		t.Fatalf("sources = %#v result = %#v", sources, result)
	}

	evidence.Entities = []string{"Max Wang"}
	weak := CompactRecall(evidence, nil)
	if weak["status"] != "weak" || len(weak["bullets"].([]string)) != 2 || weak["note"] == nil {
		t.Fatalf("weak = %#v", weak)
	}
}

func TestQueryVariantsJoinsSpokenNames(t *testing.T) {
	for query, want := range map[string]string{
		"level 8":           "level 8|level8|lev8",
		"Level eight files": "Level eight files|Level8 files|Lev8 files",
		"Q3 budget":         "Q3 budget",
	} {
		if got := strings.Join(QueryVariants(query), "|"); got != want {
			t.Fatalf("%q variants=%q want %q", query, got, want)
		}
	}
}

func TestCreateRoomToolIsAConfirmedWriteWithOptionalMembers(t *testing.T) {
	for _, tool := range Tools {
		if tool.Name != ToolCreateRoom {
			continue
		}
		required, _ := tool.Parameters["required"].([]string)
		if strings.Join(required, ",") != "name,confirmed" {
			t.Fatalf("required = %v", required)
		}
		properties := tool.Parameters["properties"].(map[string]any)
		members := properties["members"].(map[string]any)
		if members["type"] != "array" || members["maxItems"] != MaxRoomMembers {
			t.Fatalf("members schema = %v", members)
		}
		var args CreateRoomArguments
		if err := DecodeArguments(`{"name":"Launch group","members":["bob","Codex"],"confirmed":"true"}`, &args); err != nil ||
			!args.Confirmed || args.Name != "Launch group" || len(args.Members) != 2 {
			t.Fatalf("args = %+v, err = %v", args, err)
		}
		return
	}
	t.Fatal("create_room is not offered")
}

func TestMatchMembersResolvesSpokenNames(t *testing.T) {
	directory := []DirectoryActor{
		{ID: "a-self", Name: "Alice", Kind: "human"},
		{ID: "a-bob", Name: "Bob Li", Kind: "human"},
		{ID: "a-bobby", Name: "Bobby", Kind: "human"},
		{ID: "a-zhang", Name: "Zhang San", Kind: "human"},
		{ID: "a-codex", Name: "Codex", Kind: "agent"},
	}
	got := MatchMembers([]string{"Zhang San", "codex", " bob li ", "Zhang San", "alice"}, directory, "a-self")
	if got.Problem != nil || strings.Join(got.IDs, ",") != "a-zhang,a-codex,a-bob" || strings.Join(got.Names, ",") != "Zhang San,Codex,Bob Li" {
		t.Fatalf("match = %+v", got)
	}
	if got := MatchMembers([]string{"bob"}, directory, "a-self"); got.Problem["error"] != "member_ambiguous" ||
		strings.Join(got.Problem["candidates"].([]string), ",") != "Bob Li,Bobby" {
		t.Fatalf("ambiguous = %+v", got.Problem)
	}
	if got := MatchMembers([]string{"Wang Wu"}, directory, "a-self"); got.Problem["error"] != "member_not_found" || got.Problem["name"] != "Wang Wu" {
		t.Fatalf("missing = %+v", got.Problem)
	}
	if got := MatchMembers([]string{"Bobby"}, directory, "a-self"); got.Problem != nil || strings.Join(got.IDs, ",") != "a-bobby" {
		t.Fatalf("exact name should win over containing names: %+v", got)
	}
}

func TestInstructionsNameTheRoomAndNeverRefuseBackgroundWork(t *testing.T) {
	text := Instructions("Ann's Another Me", "Weekly r\u00e9sum\u00e9", UserMemory{})
	for _, want := range []string{"Ann's Another Me", "room \"Weekly r\u00e9sum\u00e9\"", "Never say you cannot do something that background work can do", "never fill the gap with what happens to be on the screen"} {
		if !strings.Contains(text, want) {
			t.Fatalf("instructions miss %q", want)
		}
	}
}

func TestInstructionsCarryTheUsersMemory(t *testing.T) {
	if strings.Contains(Instructions("A", "R", UserMemory{}), "About the User") {
		t.Fatal("no memory, no section")
	}
	text := Instructions("A", "R", UserMemory{Name: "Zh\u00e8ng", Markdown: "- Leads product at Linger\n" + strings.Repeat("\U0001F332", 2000)})
	for _, want := range []string{"## About the User", "Name: Zh\u00e8ng", "Leads product at Linger"} {
		if !strings.Contains(text, want) {
			t.Fatalf("instructions miss %q", want)
		}
	}
	if strings.Count(text, "\U0001F332") > 1200 {
		t.Fatal("the memory is bounded")
	}
}
