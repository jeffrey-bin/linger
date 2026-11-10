package native

import "strings"

// piAngleLimit bounds an angle token: its closing '>' must lie within the
// first 64 bytes from '<'. Streaming holds back exactly that much, so the
// visible text never depends on chunk boundaries.
const piAngleLimit = 64

const piAltQuote = `<|"|>`

var piCallPrefixes = []string{"call:", "response:"}

// piMarkupFilter removes model control fragments from assistant text. It is
// byte-oriented; push holds back possible fragment prefixes until more bytes
// arrive, and flush releases anything still incomplete as literal text.
type piMarkupFilter struct {
	held []byte
}

func (f *piMarkupFilter) push(chunk string) string {
	return f.scan(chunk, false)
}

func (f *piMarkupFilter) flush() string {
	return f.scan("", true)
}

func piFilterMarkup(text string) string {
	var filter piMarkupFilter
	return filter.scan(text, true)
}

type piMatch int

const (
	piLiteral piMatch = iota
	piRemove
	piHold
)

func (f *piMarkupFilter) scan(chunk string, final bool) string {
	buf := f.held
	f.held = nil
	buf = append(buf, chunk...)
	var out strings.Builder
	for i := 0; i < len(buf); {
		var outcome piMatch
		var size int
		switch buf[i] {
		case '<':
			outcome, size = piMatchAngle(buf[i:], final)
		case 'c', 'r':
			outcome, size = piMatchCall(buf[i:], final)
		default:
			outcome = piLiteral
		}
		switch outcome {
		case piRemove:
			i += size
		case piHold:
			f.held = append([]byte(nil), buf[i:]...)
			return out.String()
		default:
			out.WriteByte(buf[i])
			i++
		}
	}
	return out.String()
}

func piNameByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-'
}

func piNameRun(s []byte, from int) int {
	for from < len(s) && piNameByte(s[from]) {
		from++
	}
	return from
}

// piMatchAngle handles tokens such as <|analysis|>, <assistant|> and <|x>.
// A token opened with '|' also swallows the name run that follows it.
func piMatchAngle(s []byte, final bool) (piMatch, int) {
	end := 1
	for end < len(s) && end < piAngleLimit && (piNameByte(s[end]) || s[end] == '|') {
		end++
	}
	if end == len(s) {
		if !final && len(s) < piAngleLimit {
			return piHold, 0
		}
		return piLiteral, 0
	}
	if end == piAngleLimit || s[end] != '>' {
		return piLiteral, 0
	}
	body := s[1:end]
	core := strings.Trim(string(body), "|")
	if core == "" || strings.Contains(core, "|") {
		return piLiteral, 0
	}
	opened := body[0] == '|'
	if !opened && body[len(body)-1] != '|' {
		return piLiteral, 0
	}
	size := end + 1
	if opened {
		size = piNameRun(s, size)
		if size == len(s) && !final {
			return piHold, 0
		}
	}
	return piRemove, size
}

// piMatchCall handles call:name{...} and response:name{...} objects.
func piMatchCall(s []byte, final bool) (piMatch, int) {
	prefix := ""
	for _, candidate := range piCallPrefixes {
		if len(s) >= len(candidate) && string(s[:len(candidate)]) == candidate {
			prefix = candidate
			break
		}
		if !final && len(s) < len(candidate) && candidate[:len(s)] == string(s) {
			return piHold, 0
		}
	}
	if prefix == "" {
		return piLiteral, 0
	}
	open := piNameRun(s, len(prefix))
	if open == len(s) {
		if final {
			return piLiteral, 0
		}
		return piHold, 0
	}
	if open == len(prefix) || s[open] != '{' {
		return piLiteral, 0
	}
	if size, ok := piBalancedObject(s, open); ok {
		return piRemove, size
	}
	if final {
		return piLiteral, 0
	}
	return piHold, 0
}

// piBalancedObject returns the length up to the brace that closes s[open].
// Braces inside "..." strings or <|"|> regions do not count.
func piBalancedObject(s []byte, open int) (int, bool) {
	depth := 0
	quoted, alternate := false, false
	for i := open; i < len(s); {
		if len(s)-i >= len(piAltQuote) && string(s[i:i+len(piAltQuote)]) == piAltQuote {
			if !quoted {
				alternate = !alternate
			}
			i += len(piAltQuote)
			continue
		}
		c := s[i]
		switch {
		case quoted:
			if c == '\\' {
				i++
			} else if c == '"' {
				quoted = false
			}
		case alternate:
			if c == '|' {
				alternate = false
			}
		case c == '"':
			quoted = true
		case c == '{':
			depth++
		case c == '}':
			depth--
			if depth == 0 {
				return i + 1, true
			}
		}
		i++
	}
	return 0, false
}
