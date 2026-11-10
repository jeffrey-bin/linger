package voicemedia

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

func TestRemapRecoverySpeakersUsesOverlapAndAllocatesNewIDs(t *testing.T) {
	t.Parallel()
	prefix := []voicetranscription.StreamingResult{
		{Text: "left", StartMS: 53000, EndMS: 54800, SpeakerID: "spk_2"},
	}
	incoming := []voicetranscription.StreamingResult{
		{Text: "overlap", StartMS: 54000, EndMS: 55800, SpeakerID: "spk_1"},
		{Text: "new", StartMS: 56000, EndMS: 58000, SpeakerID: "spk_2"},
	}
	got := remapRecoverySpeakers(prefix, incoming, 55000)
	if len(got) != 2 || got[0].SpeakerID != "spk_2" || got[1].SpeakerID != "spk_3" {
		t.Fatalf("remapped=%+v", got)
	}
}

func TestMergeRecoverySegmentsRemapsDisconnectedIncomingSpeaker(t *testing.T) {
	t.Parallel()
	existing := []voicetranscription.StreamingResult{
		{Text: "hello", StartMS: 40000, EndMS: 50000, SpeakerID: "spk_1"},
	}
	incoming := []voicetranscription.StreamingResult{
		{Text: "there", StartMS: 54500, EndMS: 56000, SpeakerID: "spk_1"},
	}
	got, err := mergeRecoverySegments(existing, incoming, 55000)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].SpeakerID != "spk_1" || got[1].SpeakerID != "spk_2" {
		t.Fatalf("merged=%+v", got)
	}
}
