package document

import "testing"

func TestDuplicateTitlePreservesFileExtension(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		source     string
		copyNumber int
		want       string
	}{
		{name: "markdown", source: "untitled.md", copyNumber: 1, want: "untitled copy.md"},
		{name: "numbered", source: "untitled.md", copyNumber: 2, want: "untitled copy 2.md"},
		{name: "page title", source: "Decision log", copyNumber: 1, want: "Decision log copy"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := duplicateTitle(test.source, test.copyNumber); got != test.want {
				t.Fatalf("duplicateTitle(%q, %d)=%q want %q", test.source, test.copyNumber, got, test.want)
			}
		})
	}
}
