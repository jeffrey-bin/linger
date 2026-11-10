package voicemedia

import (
	"errors"
	"reflect"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

func TestRecoveryPlanPreservesVerifiedLiveSpeech(t *testing.T) {
	media := []store.CaptureMediaRange{{Kind: "media", EndOffsetMs: 3_600_000}}
	coverage := []store.CaptureTranscriptCoverage{{StartOffsetMs: 5000, EndOffsetMs: 2_005_000}, {StartOffsetMs: 2_007_000, EndOffsetMs: 3_605_000}}
	speech := []store.VoiceTranscriptSegment{{StartOffsetMs: 2_001_000, EndOffsetMs: 2_005_000}, {StartOffsetMs: 2_007_000, EndOffsetMs: 2_011_000}}
	plan := planTranscriptRecovery(3_600_000, 5000, media, coverage, nil, speech, false)
	// Two-second outage + context, expanded to whole adjacent utterances.
	if !reflect.DeepEqual(plan, []recoveryRange{{1_996_000, 2_006_000}}) {
		t.Fatalf("localized plan=%+v", plan)
	}
	if full := planTranscriptRecovery(3_600_000, 5000, media, coverage, nil, speech, true); !reflect.DeepEqual(full, []recoveryRange{{0, 3_600_000}}) {
		t.Fatal(full)
	}
}

func TestRecoveryPlanUsesCoverageAndExplicitUncertaintyNotSilence(t *testing.T) {
	media := []store.CaptureMediaRange{{Kind: "media", EndOffsetMs: 60_000}}
	coverage := []store.CaptureTranscriptCoverage{{EndOffsetMs: 60_000}}
	if plan := planTranscriptRecovery(60_000, 0, media, coverage, nil, nil, false); len(plan) != 0 {
		t.Fatal("silence requested ASR", plan)
	}
	uncertainty := []store.VoiceTranscriptUncertainty{{StartOffsetMs: 20_000, EndOffsetMs: 21_000}, {StartOffsetMs: 40_000, EndOffsetMs: 41_000}}
	plan := planTranscriptRecovery(60_000, 0, media, coverage, uncertainty, nil, false)
	if !reflect.DeepEqual(plan, []recoveryRange{{18_000, 23_000}, {38_000, 43_000}}) {
		t.Fatal(plan)
	}
}

func TestRecoveryPlanMapsMediaGapsAndKeepsResumeCursorHonest(t *testing.T) {
	media := []store.CaptureMediaRange{{Kind: "media", EndOffsetMs: 10_000}, {Kind: "gap", StartOffsetMs: 10_000, EndOffsetMs: 20_000}, {Kind: "media", StartOffsetMs: 20_000, EndOffsetMs: 40_000}}
	mapped := sourceRecoveryRanges([]recoveryRange{{8_000, 22_000}}, media, 1000)
	if !reflect.DeepEqual(mapped, []recoveryRange{{7_000, 11_000}}) {
		t.Fatal(mapped)
	}
	plan := []recoveryRange{{10_000, 15_000}, {30_000, 35_000}}
	blocks := []recoveryBlock{{Start: 10_000, End: 15_000}, {Start: 30_000, End: 35_000}}
	if err := validateRecoveryPlanBlocks(plan, blocks, 60_000); err != nil {
		t.Fatal(err)
	}
	if err := validateRecoveryPlanBlocks(plan, blocks[:1], 60_000); err == nil {
		t.Fatal("missing repair certified")
	}
	if err := validateRecoveryPlanBlocks(plan, blocks[:1], 30_000); err != nil {
		t.Fatal("verified gap cannot resume", err)
	}
}

func TestLocalizedRecoveryTrimsOnlyProvenContext(t *testing.T) {
	segment := archiveTestSegment(t, "before after", 1000, 3000, archiveTestWord{"before", 1000, 1800}, archiveTestWord{"after", 2200, 3000})
	clipped, err := clipLocalizedRecovery([]voicetranscription.StreamingResult{segment}, 2000)
	if err != nil || len(clipped) != 1 || clipped[0].Text != "after" || clipped[0].StartMS != 2200 {
		t.Fatalf("clip=%+v err=%v", clipped, err)
	}
	if _, valid := recoveryWordCharacters(clipped[0]); !valid {
		t.Fatal("invalid word mapping")
	}
	if _, err := clipLocalizedRecovery([]voicetranscription.StreamingResult{segment}, 2500); !errors.Is(err, errRecoveryLocalizedBoundary) {
		t.Fatal("cut through a word", err)
	}
	segment.Words = nil
	if _, err := clipLocalizedRecovery([]voicetranscription.StreamingResult{segment}, 2000); !errors.Is(err, errRecoveryLocalizedBoundary) {
		t.Fatal("guessed untimed text", err)
	}
}
