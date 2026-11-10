package native

import (
	"strings"
	"testing"
)

var piMarkupExamples = map[string]string{
	`Début <|analysis|>hidden call:tool{"path":"{value}","nested":{"x":1}} Fin`: "Début   Fin",
	`a response:tool{value:<|"|>{literal}<|"|>} b`:                              "a  b",
	`<plain> & call: prose <|incomplete`:                                        `<plain> & call: prose <|incomplete`,
	`visible <assistant|> tail`:                                                 "visible  tail",
	`<|x>name rest`:                                                             " rest",
	`call:tool{"unterminated`:                                                   `call:tool{"unterminated`,
	`recall:x{"a":"}"} done <||> <a|b|c>`:                                       `re done <||> <a|b|c>`,
	`escaped response:t{"q\"}"} end`:                                            `escaped  end`,
	`<|` + strings.Repeat("a", 61) + `|> <|` + strings.Repeat("a", 60) + `|>x`:  `<|` + strings.Repeat("a", 61) + `|> `,
}

func piStreamChunks(chunks []string) string {
	var filter piMarkupFilter
	var out strings.Builder
	for _, chunk := range chunks {
		out.WriteString(filter.push(chunk))
	}
	out.WriteString(filter.flush())
	return out.String()
}

func TestPiMarkupFilterChunkInvariance(t *testing.T) {
	for input, want := range piMarkupExamples {
		if got := piFilterMarkup(input); got != want {
			t.Errorf("whole %q = %q, want %q", input, got, want)
		}
		if got := piStreamChunks([]string{input}); got != want {
			t.Errorf("one chunk %q = %q", input, got)
		}
		for split := 0; split <= len(input); split++ {
			if got := piStreamChunks([]string{input[:split], input[split:]}); got != want {
				t.Fatalf("split %d of %q = %q, want %q", split, input, got, want)
			}
		}
		bytes := make([]string, len(input))
		for i := 0; i < len(input); i++ {
			bytes[i] = input[i : i+1]
		}
		if got := piStreamChunks(bytes); got != want {
			t.Errorf("bytewise %q = %q, want %q", input, got, want)
		}
	}
}

func TestPiMarkupFilterStreamsVisibleTextEarly(t *testing.T) {
	var filter piMarkupFilter
	if got := filter.push("hello <|ana"); got != "hello " {
		t.Fatalf("pushed = %q", got)
	}
	if got := filter.push("lysis|>secret more."); got != " more." {
		t.Fatalf("pushed = %q", got)
	}
	if got := filter.push(" ca"); got != " " {
		t.Fatalf("held prefix = %q", got)
	}
	if got := filter.flush(); got != "ca" {
		t.Fatalf("flushed = %q", got)
	}
}
