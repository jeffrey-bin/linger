package native

import (
	"log/slog"
	"strings"
)

// flagArity says how many following words a reserved flag consumes.
type flagArity int

const (
	// flagTakesValue drops the next word when the value is not inline.
	flagTakesValue flagArity = iota
	// flagStandalone drops only the flag.
	flagStandalone
	// flagOptionalValue drops the next word unless it starts with "-".
	flagOptionalValue
)

// filterAdapterArgs removes adapter-owned flags from each user argv list
// (Computer args first, then Agent args) and concatenates the rest. Words
// are unquoted first; a removed operand never becomes a positional prompt.
func filterAdapterArgs(logger *slog.Logger, reserved map[string]flagArity, lists ...[]string) []string {
	if logger == nil {
		logger = slog.Default()
	}
	var out []string
	for _, list := range lists {
		for i := 0; i < len(list); i++ {
			word := unquoteArg(list[i])
			name, _, inline := strings.Cut(word, "=")
			arity, isReserved := reserved[name]
			if !isReserved {
				out = append(out, word)
				continue
			}
			logger.Warn("runtime option is adapter-owned", "flag", name)
			if inline || i+1 >= len(list) {
				continue
			}
			switch arity {
			case flagTakesValue:
				i++
			case flagOptionalValue:
				if !strings.HasPrefix(unquoteArg(list[i+1]), "-") {
					i++
				}
			}
		}
	}
	return out
}

// unquoteArg strips one pair of matching outer quotes. For --flag=value only
// the value part is unquoted.
func unquoteArg(word string) string {
	if strings.HasPrefix(word, "-") {
		if name, value, ok := strings.Cut(word, "="); ok {
			return name + "=" + stripQuotes(value)
		}
		return word
	}
	return stripQuotes(word)
}

func stripQuotes(value string) string {
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		return value[1 : len(value)-1]
	}
	return value
}
