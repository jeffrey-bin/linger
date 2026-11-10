package document

import (
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"
)

func TestSafeSourceFilenameFitsEveryReceiver(t *testing.T) {
	ninetyWide := strings.Repeat("€", 90)
	for _, testCase := range []struct{ name, filename, want string }{
		{name: "valid name unchanged", filename: "Größe plan#1.ts", want: "Größe plan#1.ts"},
		{name: "control characters", filename: "plan\tv2\n\x7f.md", want: "plan v2  .md"},
		{name: "long name keeps extension", filename: ninetyWide + ".md", want: strings.Repeat("€", 84) + ".md"},
		{name: "cut at a character boundary", filename: "a" + ninetyWide + ".md", want: "a" + strings.Repeat("€", 83) + ".md"},
		{name: "overlong extension is not kept", filename: "a." + strings.Repeat("b", 300), want: "a." + strings.Repeat("b", 253)},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got := SafeSourceFilename(testCase.filename)
			if got != testCase.want {
				t.Fatalf("SafeSourceFilename(%q)=%q, want %q", testCase.filename, got, testCase.want)
			}
			if len(got) > 255 || !utf8.ValidString(got) || len(utf16.Encode([]rune(got))) > 255 ||
				strings.ContainsFunc(got, func(character rune) bool { return character <= 0x1f || character == 0x7f }) {
				t.Fatalf("SafeSourceFilename(%q)=%q does not fit LLM Wiki", testCase.filename, got)
			}
		})
	}
}
