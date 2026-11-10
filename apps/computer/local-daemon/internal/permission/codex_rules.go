package permission

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

// CodexRulesFile is the execpolicy file the Daemon owns in a Context's CODEX_HOME.
const CodexRulesFile = "linger-managed.rules"

// CodexRules renders the execpolicy allow rules: the commands that only read
// whatever their arguments, git status, and the TeamHub CLI commands that run
// without review. Codex splits compound commands and refuses redirections
// itself, so `cat a > b` or `ls && rm x` still asks.
func CodexRules(teamhubCommands []TeamHubCommand) string {
	var rules strings.Builder
	rules.WriteString("# Written by the Linger Computer Daemon on every Run; edits are replaced.\n")
	readOnly := readOnlyNames
	if runtime.GOOS == "linux" {
		readOnly = append(slices.Clip(readOnly), linuxReadOnlyNames...)
	}
	for _, name := range readOnly {
		writeRule(&rules, []string{name})
	}
	writeRule(&rules, []string{"git", "status"})
	for _, command := range teamhubCommands {
		writeRule(&rules, append([]string{"teamhub"}, command.Path...))
	}
	return rules.String()
}

func writeRule(rules *strings.Builder, pattern []string) {
	encoded, _ := json.Marshal(pattern)
	rules.WriteString("prefix_rule(pattern = " + string(encoded) + `, decision = "allow")` + "\n")
}

// CodexWriteRules replaces the managed rules in a CODEX_HOME. Rules from the
// Computer user's own Codex home are never copied there.
func CodexWriteRules(codexHome, rules string) error {
	directory := filepath.Join(codexHome, "rules")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	path := filepath.Join(directory, CodexRulesFile)
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, []byte(rules), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
