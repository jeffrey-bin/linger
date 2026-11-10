package voice

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

func TestRenderCaptureTranscriptIncludesSpeakerLabels(t *testing.T) {
	t.Parallel()
	segments := []store.VoiceTranscriptSegment{
		{Kind: "speech", Text: "First sentence.", StartOffsetMs: 1_000, EndOffsetMs: 2_000, SpeakerID: pgtype.Text{String: "spk_1", Valid: true}},
		{Kind: "speech", Text: "Second sentence.", StartOffsetMs: 2_000, EndOffsetMs: 3_000, SpeakerID: pgtype.Text{String: "spk_2", Valid: true}},
	}
	want := "# Recording Transcript\n\n[00:00:01 - 00:00:02] Speaker 1 First sentence.\n\n[00:00:02 - 00:00:03] Speaker 2 Second sentence.\n"
	if got := renderCaptureTranscriptFrom(segments, 0, nil, time.Time{}); got != want {
		t.Fatalf("renderCaptureTranscript()=%q, want %q", got, want)
	}
}

func TestRenderCaptureTranscriptDisclosesAndCompactsMediaGaps(t *testing.T) {
	t.Parallel()
	segments := []store.VoiceTranscriptSegment{
		{Kind: "speech", Text: "Before the interruption.", StartOffsetMs: 2_000, EndOffsetMs: 3_000},
		{Kind: "speech", Text: "During the interruption.", StartOffsetMs: 4_500, EndOffsetMs: 5_500},
		{Kind: "speech", Text: "After the interruption.", StartOffsetMs: 8_000, EndOffsetMs: 9_000},
	}
	want := "# Recording Transcript \u2014 September 10, 2026 at 06:45 UTC\n\n> This recording contains 1 unrecoverable interruption(s), totaling 00:00:03 of missing audio. Timestamps below are compressed to the available audio.\n\n[00:00:01 - 00:00:02] Before the interruption.\n\n[Recognized during missing audio] During the interruption.\n\n[00:00:04 - 00:00:05] After the interruption.\n"
	if got := renderCaptureTranscriptFrom(segments, 1_000, []voicemedia.MediaTimeRange{
		{StartMS: 3_000, EndMS: 6_000},
	}, time.Date(2026, 9, 10, 6, 45, 12, 0, time.UTC)); got != want {
		t.Fatalf("renderCaptureTranscript()=%q, want %q", got, want)
	}
}

func TestRenderCaptureTranscriptEmptyContent(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name string
		gaps []voicemedia.MediaTimeRange
		want string
	}{
		{name: "without gaps", want: "# Recording Transcript\n\nNo speech was recognized.\n"},
		{name: "with gaps", gaps: []voicemedia.MediaTimeRange{{StartMS: 3_000, EndMS: 6_000}},
			want: "# Recording Transcript\n\n> This recording contains 1 unrecoverable interruption(s), totaling 00:00:03 of missing audio. Timestamps below are compressed to the available audio.\n\nNo speech was recognized.\n"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			if got := renderCaptureTranscriptFrom(nil, 0, scenario.gaps, time.Time{}); got != scenario.want {
				t.Fatalf("renderCaptureTranscriptFrom()=%q, want %q", got, scenario.want)
			}
		})
	}
}

func TestFormatVoiceTranscriptDurationRoundsUpMissingAudio(t *testing.T) {
	t.Parallel()
	if got := formatVoiceTranscriptDuration(12_930); got != "00:00:13" {
		t.Fatalf("formatVoiceTranscriptDuration()=%q want=00:00:13", got)
	}
}
