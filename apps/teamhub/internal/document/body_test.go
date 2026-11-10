package document

import "testing"

func TestSortedIDsNeverReturnsNil(t *testing.T) {
	for _, input := range [][]string{nil, {}} {
		if got := sortedIDs(input); got == nil {
			t.Fatalf("sortedIDs(%#v) = nil; pgx would write NULL into a NOT NULL column", input)
		}
	}
	input := []string{"b", "a"}
	if got := sortedIDs(input); got[0] != "a" || got[1] != "b" || input[0] != "b" {
		t.Fatalf("sortedIDs sorted %v into %v", input, got)
	}
}
