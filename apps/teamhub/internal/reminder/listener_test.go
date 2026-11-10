package reminder

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// A trigger takes exactly the listener shapes the proactive installer writes,
// normalized; anything else is invalid.
func TestParseTriggerSpecAcceptsOnlyInstalledShapes(t *testing.T) {
	specs, canonical, err := parseTriggerSpec(json.RawMessage(`[
		{"type":"slack","account":" conn_slack ","channel":"*","match":{"kind":"mention"}},
		{"type":"gmail","account":"conn_gmail","match":{"label_id":"INBOX"}},
		{"type":"gmail","account":"conn_gmail"},
		{"type":"outlook","account":"conn_outlook","poll_interval_seconds":600},
		{"type":"gcal","account":"conn_gcal","events":[" created ","cancelled"]}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	if specs[0].Account != "conn_slack" || specs[4].CalendarID != "primary" || specs[4].Events[0] != "created" {
		t.Fatalf("not normalized: %+v", specs)
	}
	if !strings.Contains(string(canonical), `"calendar_id":"primary"`) {
		t.Fatalf("canonical trigger %s", canonical)
	}
	nine := "[" + strings.TrimSuffix(strings.Repeat(`{"type":"outlook","account":"a"},`, 9), ",") + "]"
	for name, raw := range map[string]string{
		"object":             `{"type":"gmail","account":"a"}`,
		"empty":              `[]`,
		"nine listeners":     nine,
		"no account":         `[{"type":"gmail"}]`,
		"slack channel":      `[{"type":"slack","account":"a","channel":"C1","match":{"kind":"mention"}}]`,
		"slack keyword":      `[{"type":"slack","account":"a","channel":"*","match":{"kind":"keyword"}}]`,
		"gmail kind":         `[{"type":"gmail","account":"a","match":{"kind":"mention"}}]`,
		"outlook match":      `[{"type":"outlook","account":"a","match":{"label_id":"INBOX"}}]`,
		"gcal without event": `[{"type":"gcal","account":"a"}]`,
		"gcal unknown event": `[{"type":"gcal","account":"a","events":["moved"]}]`,
		"teams":              `[{"type":"teams","account":"a"}]`,
		"fast poll":          `[{"type":"outlook","account":"a","poll_interval_seconds":30}]`,
	} {
		if _, _, err := parseTriggerSpec(json.RawMessage(raw)); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err=%v, want ErrInvalid", name, err)
		}
	}
}

func TestMatchEventAppliesTheSpecFilter(t *testing.T) {
	inbox := ListenerSpec{Type: ListenerGmail, Match: &ListenerMatch{LabelID: "INBOX"}}
	calendar := ListenerSpec{Type: ListenerGCal, Events: []string{"created", "cancelled"}}
	for _, tc := range []struct {
		name  string
		spec  ListenerSpec
		event ListenerEvent
		want  bool
	}{
		{"slack mention", ListenerSpec{Type: ListenerSlack}, ListenerEvent{IsMention: true}, true},
		{"slack chatter", ListenerSpec{Type: ListenerSlack}, ListenerEvent{}, false},
		{"gmail inbox", inbox, ListenerEvent{LabelIDs: []string{"UNREAD", "INBOX"}}, true},
		{"gmail sent", inbox, ListenerEvent{LabelIDs: []string{"SENT"}}, false},
		{"gmail any label", ListenerSpec{Type: ListenerGmail}, ListenerEvent{LabelIDs: []string{"SENT"}}, true},
		{"outlook", ListenerSpec{Type: ListenerOutlook}, ListenerEvent{}, true},
		{"calendar created", calendar, ListenerEvent{EventKind: "created"}, true},
		{"calendar updated", calendar, ListenerEvent{EventKind: "updated"}, false},
		{"unknown type", ListenerSpec{Type: "teams"}, ListenerEvent{}, false},
	} {
		if got := MatchEvent(tc.spec, tc.event); got != tc.want {
			t.Errorf("%s: MatchEvent=%v, want %v", tc.name, got, tc.want)
		}
	}
}

// A listener Routine is listed by its connection provider.
func TestListenerOfNamesTheProvider(t *testing.T) {
	for trigger, want := range map[string]string{
		`[{"type":"gcal","account":"a","events":["created"]}]`: "google_calendar",
		`[{"type":"gmail","account":"a"}]`:                     "gmail",
		`[{"type":"slack","account":"a"}]`:                     "slack",
	} {
		if got := listenerOf([]byte(trigger)); got == nil || got.App != want {
			t.Errorf("%s: listener=%+v, want %s", trigger, got, want)
		}
	}
	if got := listenerOf([]byte(`{}`)); got != nil {
		t.Errorf("malformed trigger named %+v", got)
	}
}
