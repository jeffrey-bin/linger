package messagereaction

import "testing"

func TestReactionLibraryMatchesTheSharedEmojiSet(t *testing.T) {
	if len(reactionIDs) != 1870 {
		t.Fatalf("official Reaction library size=%d want 1870", len(reactionIDs))
	}
	for _, id := range []string{"joy", "ok_hand", "+1", "sweat_smile", "cry", "tada", "heart", "rocket", "eyes", "pray", "fire", "smile"} {
		if !ValidReactionID(id) {
			t.Fatalf("%s is missing from the library", id)
		}
	}
	for _, id := range []string{"", "unicorn", "laugh", "JOY", "joy ", "😂"} {
		if ValidReactionID(id) {
			t.Fatalf("%q was accepted", id)
		}
	}
}
