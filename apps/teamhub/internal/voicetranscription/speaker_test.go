package voicetranscription

import "testing"

func TestSpeakerIDIndexing(t *testing.T) {
	t.Parallel()
	if got := SpeakerIDFromOneBased(1); got != "spk_1" {
		t.Fatalf("one-based 1=%q", got)
	}
	if SpeakerIDFromOneBased(0) != "" {
		t.Fatal("invalid indexes must stay unlabeled")
	}
}

func TestSpeakerLabel(t *testing.T) {
	t.Parallel()
	if got := SpeakerLabel("spk_2"); got != "Speaker 2" {
		t.Fatalf("label=%q", got)
	}
	if SpeakerLabel("speaker-1") != "" || SpeakerLabel("spk_0") != "" {
		t.Fatal("invalid ids must not produce a label")
	}
}
