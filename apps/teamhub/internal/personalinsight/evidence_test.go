package personalinsight

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/emailevidence"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalprofile"
)

func TestBuildEvidenceRoutesStructuredGmail(t *testing.T) {
	messages, err := json.Marshal([]emailevidence.MessageInput{
		{ThreadID: "thread-1", MessageID: "self", Direction: emailevidence.DirectionOutbound, Body: "I prefer written proposals."},
		{ThreadID: "thread-2", MessageID: "promo", Direction: emailevidence.DirectionInbound, Signals: emailevidence.Signals{Category: "promotions"}, Body: "Buy now."},
	})
	if err != nil {
		t.Fatal(err)
	}
	gmail := personalprofile.InsightDocument{Provider: "gmail", Filename: "insight/thread-1.md", Content: string(messages)}

	evidence, err := buildEvidence("generation-1", "actor-1", []personalprofile.InsightDocument{gmail, gmail})
	if err != nil {
		t.Fatal(err)
	}
	if len(evidence) != 1 {
		t.Fatalf("evidence=%+v", evidence)
	}
	if evidence[0].Source.EmailClass != emailevidence.MessageClassSelfSent || evidence[0].Source.SubjectID != "actor-1" || evidence[0].Source.DatasetID != "generation-1" {
		t.Fatalf("unexpected Gmail evidence: %+v", evidence[0])
	}
}

func TestBuildEvidenceReadsOnlyGmail(t *testing.T) {
	outlook := personalprofile.InsightDocument{Provider: "outlook", Filename: "insight/thread-1.md", Content: "not Gmail message inputs"}

	evidence, err := buildEvidence("generation-1", "actor-1", []personalprofile.InsightDocument{outlook})
	if err != nil {
		t.Fatal(err)
	}
	if len(evidence) != 0 {
		t.Fatalf("Outlook evidence became Insight evidence: %+v", evidence)
	}
}

func TestEvidenceForStorageBoundsExcerptWithoutChangingInput(t *testing.T) {
	original := strings.Repeat("€", storedExcerptRunes+10)
	items := []InsightEvidence{{Source: EvidenceReference{Excerpt: original}}}
	stored := evidenceForStorage(items)
	if len([]rune(stored[0].Source.Excerpt)) != storedExcerptRunes {
		t.Fatalf("stored excerpt runes=%d", len([]rune(stored[0].Source.Excerpt)))
	}
	if items[0].Source.Excerpt != original {
		t.Fatal("input evidence was mutated")
	}
}

func TestContentFingerprintIgnoresWhitespaceAndCase(t *testing.T) {
	left := contentFingerprint("Working Style", "Prefers written plans")
	right := contentFingerprint(" working   style ", "prefers  WRITTEN plans")
	if left != right {
		t.Fatalf("fingerprints differ: %s %s", left, right)
	}
}
