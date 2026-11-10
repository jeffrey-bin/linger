package emailevidence

import (
	"encoding/json"
	"os"
	"testing"
)

type syntheticFixture struct {
	Messages []MessageInput `json:"messages"`
}

func TestSyntheticFixtureClassification(t *testing.T) {
	fixture := loadSyntheticFixture(t)
	classified, err := Classify(fixture.Messages)
	if err != nil {
		t.Fatal(err)
	}

	classCounts := map[MessageClass]int{}
	for _, message := range classified {
		classCounts[message.Class]++
		if message.Evidence.EvidenceID == "" || message.Evidence.BodySHA256 == "" || message.Evidence.Excerpt == "" {
			t.Fatalf("classified message lacks evidence provenance: %+v", message)
		}
	}
	if classCounts[MessageClassSelfSent] != 1 || classCounts[MessageClassDirectInbound] != 1 || classCounts[MessageClassSystemNotification] != 1 || classCounts[MessageClassSubscription] != 1 || classCounts[MessageClassMarketing] != 0 || classCounts[MessageClassDraft] != 1 {
		t.Fatalf("unexpected Synthetic class counts: %+v", classCounts)
	}
}

func TestAutomatedClassUsesOnlyStructuralSignals(t *testing.T) {
	tests := map[string]struct {
		signals Signals
		want    MessageClass
	}{
		"human":                   {Signals{Category: "CATEGORY_PERSONAL"}, ""},
		"auto submitted":          {Signals{AutoSubmitted: true}, MessageClassSystemNotification},
		"social label":            {Signals{Category: "CATEGORY_SOCIAL"}, MessageClassSystemNotification},
		"forums label":            {Signals{Category: " category_forums "}, MessageClassSystemNotification},
		"updates category":        {Signals{Category: "updates"}, MessageClassSystemNotification},
		"list id":                 {Signals{ListID: true}, MessageClassSubscription},
		"bulk precedence":         {Signals{BulkPrecedence: true}, MessageClassSubscription},
		"promotions label":        {Signals{Category: "CATEGORY_PROMOTIONS"}, MessageClassMarketing},
		"list unsubscribe":        {Signals{ListUnsubscribe: true}, MessageClassMarketing},
		"notification over list":  {Signals{AutoSubmitted: true, ListID: true, ListUnsubscribe: true}, MessageClassSystemNotification},
		"subscription over promo": {Signals{ListID: true, Category: "CATEGORY_PROMOTIONS"}, MessageClassSubscription},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			if got := AutomatedClass(test.signals); got != test.want {
				t.Fatalf("AutomatedClass(%+v)=%q, want %q", test.signals, got, test.want)
			}
		})
	}
}

func TestClassifyIgnoresSenderNamesAndBodyWording(t *testing.T) {
	classified, err := Classify([]MessageInput{
		{DatasetID: "wording", ThreadID: "a", MessageID: "m1", Direction: DirectionInbound, SenderLocal: "no-reply", Body: "A service setting changed."},
		{DatasetID: "wording", ThreadID: "b", MessageID: "m2", Direction: DirectionInbound, SenderLocal: "newsletter", Body: "This week."},
		{DatasetID: "wording", ThreadID: "c", MessageID: "m3", Direction: DirectionInbound, SenderLocal: "daily-digest", Body: "digest"},
		{DatasetID: "wording", ThreadID: "d", MessageID: "m4", Direction: DirectionInbound, SenderLocal: "grace", Body: "Welcome to Example Cloud.\n\nUnsubscribe ( https://example.com/unsubscribe )"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range classified {
		if message.Class != MessageClassDirectInbound {
			t.Fatalf("message %s classified as %s, want direct_inbound", message.MessageID, message.Class)
		}
	}
}

func loadSyntheticFixture(t *testing.T) syntheticFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/synthetic_gmail_generation.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture syntheticFixture
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Messages) == 0 {
		t.Fatal("Synthetic fixture has no normalized messages")
	}
	return fixture
}
