// Package redact removes credentials at diagnostic and tool-input boundaries.
package redact

import (
	"sort"
	"strings"
)

const hidden = "[REDACTED]"
const depthLimitPlaceholder = "[REDACTED DEPTH LIMIT]"

// InputMap copies JSON-shaped inputs. Secret field names are significant even
// when a value has no recognizable token prefix. No input container is mutated.
func InputMap(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	return copyValue(input, 0).(map[string]any)
}

func copyValue(value any, level int) any {
	if level == 32 {
		return depthLimitPlaceholder
	}
	switch value := value.(type) {
	case string:
		return Text(value)
	case map[string]any:
		if value == nil {
			return map[string]any(nil)
		}
		out := make(map[string]any, len(value))
		for key, item := range value {
			if credentialName(key) {
				out[key] = hideValue(item)
			} else {
				out[key] = copyValue(item, level+1)
			}
		}
		return out
	case map[string]string:
		if value == nil {
			return map[string]string(nil)
		}
		out := make(map[string]string, len(value))
		for key, item := range value {
			if credentialName(key) {
				out[key] = hideValue(item).(string)
			} else {
				out[key] = Text(item)
			}
		}
		return out
	case []any:
		if value == nil {
			return []any(nil)
		}
		out := make([]any, len(value))
		for i := range value {
			out[i] = copyValue(value[i], level+1)
		}
		return out
	case []string:
		if value == nil {
			return []string(nil)
		}
		out := make([]string, len(value))
		for i := range value {
			out[i] = Text(value[i])
		}
		return out
	default:
		return value
	}
}

func hideValue(value any) any {
	if s, ok := value.(string); ok {
		if s == "" {
			return ""
		}
		if strings.HasPrefix(s, "[REDACTED") && strings.IndexByte(s, ']') == len(s)-1 {
			return s
		}
		if safe := Text(s); strings.HasPrefix(safe, "[REDACTED") && strings.IndexByte(safe, ']') == len(safe)-1 {
			return safe
		}
	}
	return hidden
}

func credentialName(name string) bool {
	name = strings.ToLower(strings.NewReplacer("-", "_", ".", "_").Replace(name))
	switch name {
	case "auth", "authorization", "proxy_authorization", "cookie", "set_cookie", "password", "passwd", "secret", "token", "credentials", "credential", "database_url", "db_url", "redis_url", "private_key":
		return true
	}
	for _, suffix := range []string{"_api_key", "_apikey", "_secret", "_secret_key", "_secret_access_key", "_access_key", "_access_token", "_auth_token", "_refresh_token", "_password", "_private_key"} {
		if strings.HasSuffix("_"+name, suffix) {
			return true
		}
	}
	return false
}

type removal struct {
	start, end int
	label      string
}

// Text finds spans in the original input before replacing any of them, so
// replacement markers cannot be reinterpreted as credentials. Paths stay usable.
func Text(input string) string {
	var spans []removal
	for i := 0; i < len(input); {
		if strings.HasPrefix(input[i:], "-----BEGIN ") {
			if header := strings.Index(input[i+11:], "-----"); header >= 0 {
				kind := input[i+11 : i+11+header]
				if strings.HasSuffix(kind, "PRIVATE KEY") {
					end := len(input)
					terminator := "-----END " + kind + "-----"
					if at := strings.Index(input[i+11+header+5:], terminator); at >= 0 {
						end = i + 11 + header + 5 + at + len(terminator)
					}
					spans = append(spans, removal{i, end, "[REDACTED PRIVATE KEY]"})
					i = end
					continue
				}
			}
		}
		if !word(input[i]) {
			i++
			continue
		}
		start := i
		for i < len(input) && word(input[i]) {
			i++
		}
		atom := input[start:i]
		if label := tokenLabel(atom); label != "" {
			spans = append(spans, removal{start, start + len(strings.TrimRight(atom, ".")), label})
		}
		if strings.EqualFold(atom, "Bearer") || strings.EqualFold(atom, "Basic") {
			at := skipSpace(input, i)
			end := valueEnd(input, at)
			if at > i && end > at && !strings.HasPrefix(input[at:], hidden) {
				spans = append(spans, removal{at, end, hidden})
			}
		}
		// Parse named assignments in JSON, shell output and HTTP headers.
		if credentialName(atom) {
			at := i
			if start > 0 && (input[start-1] == '"' || input[start-1] == '\'') && at < len(input) && input[at] == input[start-1] {
				at++
			}
			at = skipSpace(input, at)
			if at < len(input) && (input[at] == ':' || input[at] == '=') {
				at = skipSpace(input, at+1)
				end := valueEnd(input, at)
				if at < len(input) && (input[at] == '"' || input[at] == '\'') {
					quote := input[at]
					at++
					end = at
					for end < len(input) && input[end] != quote {
						if input[end] == '\\' && end+1 < len(input) {
							end++
						}
						end++
					}
				} else if strings.EqualFold(atom, "authorization") || strings.EqualFold(atom, "cookie") || strings.EqualFold(atom, "set-cookie") {
					end = at
					for end < len(input) && input[end] != '\n' && input[end] != '\r' {
						end++
					}
				}
				if end > at && !strings.HasPrefix(input[at:], "[REDACTED") {
					spans = append(spans, removal{at, end, hidden})
				}
			}
		}
		// URL userinfo is sensitive for every scheme, including HTTP proxies.
		if strings.HasPrefix(input[i:], "://") {
			at := i + 3
			end := at
			for end < len(input) && !strings.ContainsRune("/\r\n\t ?#\"'<>}", rune(input[end])) {
				end++
			}
			if separator := strings.LastIndexByte(input[at:end], '@'); separator >= 0 && strings.Contains(input[at:at+separator], ":") {
				spans = append(spans, removal{at, at + separator, hidden})
			}
		}
	}
	if len(spans) == 0 {
		return input
	}
	sort.Slice(spans, func(i, j int) bool {
		if spans[i].start == spans[j].start {
			return spans[i].end > spans[j].end
		}
		return spans[i].start < spans[j].start
	})
	var out strings.Builder
	previous := 0
	for i := 0; i < len(spans); i++ {
		span := spans[i]
		for i+1 < len(spans) && spans[i+1].start < span.end {
			i++
			if spans[i].end > span.end {
				span.end = spans[i].end
			}
		}
		out.WriteString(input[previous:span.start])
		out.WriteString(span.label)
		previous = span.end
	}
	out.WriteString(input[previous:])
	return out.String()
}

func word(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '.'
}
func skipSpace(s string, at int) int {
	for at < len(s) && (s[at] == ' ' || s[at] == '\t') {
		at++
	}
	return at
}
func valueEnd(s string, at int) int {
	for at < len(s) && !strings.ContainsRune(" \t\r\n,;\"'<>)}]", rune(s[at])) {
		at++
	}
	return at
}

func tokenLabel(token string) string {
	token = strings.TrimRight(token, ".")
	if strings.HasPrefix(token, "sk-") && len(token) >= 23 {
		return "[REDACTED API KEY]"
	}
	if strings.HasPrefix(token, "AKIA") && len(token) == 20 {
		return "[REDACTED AWS KEY]"
	}
	if strings.HasPrefix(token, "AIza") && len(token) == 39 {
		return "[REDACTED GOOGLE API KEY]"
	}
	if strings.HasPrefix(token, "github_pat_") && len(token) >= 31 {
		return "[REDACTED GITHUB TOKEN]"
	}
	for _, prefix := range []string{"ghp_", "gho_", "ghu_", "ghs_", "ghr_"} {
		if strings.HasPrefix(token, prefix) && len(token) >= 40 {
			return "[REDACTED GITHUB TOKEN]"
		}
	}
	if strings.HasPrefix(token, "glpat-") && len(token) >= 26 {
		return "[REDACTED GITLAB TOKEN]"
	}
	for _, prefix := range []string{"xoxb-", "xoxp-", "xoxo-", "xoxr-", "xoxa-", "xoxs-", "xoxe-", "xapp-"} {
		if strings.HasPrefix(token, prefix) && len(token) >= 15 {
			return "[REDACTED SLACK TOKEN]"
		}
	}
	if (strings.HasPrefix(token, "sk_live_") || strings.HasPrefix(token, "rk_live_")) && len(token) >= 24 {
		return "[REDACTED STRIPE KEY]"
	}
	if parts := strings.Split(token, "."); len(parts) == 3 && strings.HasPrefix(parts[0], "ey") && len(parts[0]) >= 12 && len(parts[1]) >= 10 && len(parts[2]) >= 10 {
		return "[REDACTED JWT]"
	}
	return ""
}
