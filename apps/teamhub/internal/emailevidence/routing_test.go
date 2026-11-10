package emailevidence

import "testing"

func TestSyntheticFixtureInsightEvidence(t *testing.T) {
	fixture := loadSyntheticFixture(t)
	classified, err := Classify(fixture.Messages)
	if err != nil {
		t.Fatal(err)
	}
	assertEvidence(t, InsightEvidence(classified), []evidenceExpectation{
		{"direct-inbound", StrengthSupporting},
		{"direct-outbound", StrengthPrimary},
		{"status-inbound", StrengthSupporting},
		{"newsletter-inbound", StrengthWeak},
	})
}

func TestMarketingIsNotInsightEvidence(t *testing.T) {
	classified, err := Classify([]MessageInput{{
		DatasetID: "signals", ThreadID: "marketing", MessageID: "offer",
		Direction: DirectionInbound, Signals: Signals{Category: "CATEGORY_PROMOTIONS"}, Body: "Buy now.",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if evidence := InsightEvidence(classified); len(evidence) != 0 {
		t.Fatalf("marketing must not be Insight evidence: %+v", evidence)
	}
}

// Bodies arrive already authored-only, so an echo is an exact match after
// case and whitespace normalization.
func TestInboundEchoOfSelfSentBodyIsNotNewEvidence(t *testing.T) {
	classified, err := Classify([]MessageInput{
		{DatasetID: "echo", ThreadID: "echoed", MessageID: "self", Direction: DirectionOutbound, Body: "Hi team,\n\nAre there open roles?\n\nBests,\nAda"},
		{DatasetID: "echo", ThreadID: "echoed", MessageID: "inbound-copy", Direction: DirectionInbound, Body: "hi team,  are there open roles?\nBests, Ada"},
		{DatasetID: "echo", ThreadID: "genuine", MessageID: "inbound-reply", Direction: DirectionInbound, Body: "We have an opening. Please send your updated resume by Friday."},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertEvidence(t, InsightEvidence(classified), []evidenceExpectation{{"self", StrengthPrimary}, {"inbound-reply", StrengthSupporting}})
}

func TestEarlierInboundIsNotRemovedByLaterMatchingSelfSentBody(t *testing.T) {
	classified, err := Classify([]MessageInput{
		{DatasetID: "echo", ThreadID: "ordered", MessageID: "inbound", Direction: DirectionInbound, Body: "Please send the plan."},
		{DatasetID: "echo", ThreadID: "ordered", MessageID: "self", Direction: DirectionOutbound, Body: "Please send the plan."},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertEvidence(t, InsightEvidence(classified), []evidenceExpectation{{"inbound", StrengthSupporting}, {"self", StrengthPrimary}})
}

type evidenceExpectation struct {
	messageID string
	strength  Strength
}

func assertEvidence(t *testing.T, actual []WeightedEvidence, expected []evidenceExpectation) {
	t.Helper()
	if len(actual) != len(expected) {
		t.Fatalf("evidence length=%d, want %d: %+v", len(actual), len(expected), actual)
	}
	for index, want := range expected {
		if actual[index].Message.MessageID != want.messageID || actual[index].Strength != want.strength {
			t.Fatalf("evidence[%d]=%s/%s, want %s/%s", index, actual[index].Message.MessageID, actual[index].Strength, want.messageID, want.strength)
		}
	}
}
