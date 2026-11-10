package app

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
)

func TestVoiceEventCursorScopesAndPreservesBigint(t *testing.T) {
	for _, position := range []int64{0, 1, 9007199254740993} {
		cursor := voice.VoiceEventCursor("voice_1", position)
		actual, err := voice.ParseVoiceEventCursor("voice_1", cursor)
		if err != nil || actual != position {
			t.Fatalf("cursor=%s got=%d err=%v", cursor, actual, err)
		}
	}
	for _, cursor := range []string{"other:1", "voice_1:-1", "voice_1:01", "voice_1:1\n", "voice_1:9223372036854775808"} {
		if _, err := voice.ParseVoiceEventCursor("voice_1", cursor); err == nil {
			t.Fatalf("accepted %q", cursor)
		}
	}
}
