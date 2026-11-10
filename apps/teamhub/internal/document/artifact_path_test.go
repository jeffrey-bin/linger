package document

import "testing"

func TestParse(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name  string
		value string
		want  bool
	}{
		{name: "nested", value: "reports/result.txt", want: true},
		{name: "reserved", value: ".agents/state.json"},
		{name: "parent", value: "reports/../result.txt"},
		{name: "absolute", value: "/result.txt"},
		{name: "backslash", value: `reports\result.txt`},
		{name: "trimmed segment", value: "reports /result.txt"},
	} {

		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			components, err := Parse(test.value)
			if test.want && (err != nil || len(components) == 0) {
				t.Fatalf("Parse(%q) components=%v err=%v", test.value, components, err)
			}
			if !test.want && err == nil {
				t.Fatalf("Parse(%q) unexpectedly succeeded: %v", test.value, components)
			}
		})
	}
}
