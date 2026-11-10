package voice

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestVoiceTranscriptProgressAdvancesOnlyForActiveCapture(t *testing.T) {
	for name, test := range map[string]struct {
		hasCommittedThrough bool
		hasCapture          bool
		hasTranscriptStart  bool
		committedThroughMS  int64
		transcriptStartMS   int64
		status              string
		want                bool
	}{
		"recording":            {true, true, true, 2_000, 1_000, "recording", true},
		"finalizing":           {true, true, true, 2_000, 1_000, "finalizing", true},
		"before capture start": {true, true, true, 999, 1_000, "recording", false},
		"at capture start":     {true, true, true, 1_000, 1_000, "recording", true},
		"starting":             {true, true, true, 2_000, 1_000, "starting", false},
		"no capture":           {true, false, false, 2_000, 1_000, "", false},
		"no progress":          {false, true, true, 0, 1_000, "recording", false},
	} {
		t.Run(name, func(t *testing.T) {
			got := shouldAdvanceVoiceTranscriptProgress(
				test.hasCommittedThrough,
				test.hasCapture,
				test.hasTranscriptStart,
				test.committedThroughMS,
				test.transcriptStartMS,
				test.status,
			)
			if got != test.want {
				t.Fatalf("shouldAdvanceVoiceTranscriptProgress()=%t want=%t", got, test.want)
			}
		})
	}
}

func TestVoiceFinalFormattingOnlyDetection(t *testing.T) {
	for name, test := range map[string]struct {
		text string
		want bool
	}{
		"sentence punctuation remains content": {text: "きょうはいいてんきです。", want: false},
		"latin sentence remains content":       {text: "Ready, set, go!", want: false},
		"full width punctuation":               {text: "。！？", want: true},
		"ascii formatting":                     {text: " ,.!?: ", want: true},
	} {
		t.Run(name, func(t *testing.T) {
			if got := VoiceFinalIsFormattingOnly(test.text); got != test.want {
				t.Fatalf("VoiceFinalIsFormattingOnly(%q)=%t want=%t", test.text, got, test.want)
			}
		})
	}
}

func TestVoicePublisherAbsenceGapUsesCaptureTimeline(t *testing.T) {
	recording := store.CaptureSession{Status: "recording", TranscriptStartOffsetMs: pgtype.Int8{Int64: 10_000, Valid: true}}
	start, end, ok := voicePublisherAbsenceGap(true, recording, 612_000, 629_000)
	if !ok || start != 602_000 || end != 619_000 {
		t.Fatalf("gap=%d-%d ok=%t want 602000-619000", start, end, ok)
	}
	// Absence that began before the recording clock only counts from the clock start.
	if start, end, ok := voicePublisherAbsenceGap(true, recording, 9_000, 11_000); !ok || start != 0 || end != 1_000 {
		t.Fatalf("clamped gap=%d-%d ok=%t", start, end, ok)
	}
	if _, _, ok := voicePublisherAbsenceGap(true, recording, 20_000, 20_200); ok {
		t.Fatal("a reconnect inside the tolerance is not a gap")
	}
	if _, _, ok := voicePublisherAbsenceGap(false, recording, 20_000, 30_000); ok {
		t.Fatal("absence without an active Capture is not a gap")
	}
	starting := recording
	starting.Status = "starting"
	if _, _, ok := voicePublisherAbsenceGap(true, starting, 20_000, 30_000); ok {
		t.Fatal("absence before media began is not a gap")
	}
}
