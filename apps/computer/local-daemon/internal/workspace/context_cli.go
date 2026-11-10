package workspace

import (
	"fmt"
	"strings"
)

// CodexContextCLIArgs returns the Codex `-c` overrides that expose the
// persistent CLI profile location to provider shells. TeamHub business
// credentials remain in the private profile token file, never in provider
// config or argv. The task home's config.toml is not touched: rewriting it
// dropped the daemon's managed-block markers and produced duplicate keys (#249).
func CodexContextCLIArgs(environment map[string]string) []string {
	if environment["TEAMHUB_CONFIG"] == "" {
		return nil
	}
	var args []string
	for _, name := range []string{"TEAMHUB_CONFIG", "TEAMHUB_PROFILE", "PATH"} {
		if environment[name] == "" {
			continue
		}
		args = append(args, "-c", "shell_environment_policy.set."+name+"="+tomlString(environment[name]))
	}
	return args
}

// tomlString renders s as a TOML basic string, escaping quotes, backslashes and
// control characters, so it is safe as the value of a Codex `-c key=value`.
func tomlString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"' || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\r':
			b.WriteString(`\r`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\u%04X`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
