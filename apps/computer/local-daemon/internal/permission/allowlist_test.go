package permission

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLocalWriteToolJudgesEveryNonReadOnlyLocalAction(t *testing.T) {
	cases := []struct {
		tool, input string
		write       bool
	}{
		{"mcp__browser__browser_click", `{"element":"Send"}`, true},
		{"mcp__browser__browser_navigate", `{"url":"https://example.com"}`, true},
		{"mcp__browser__browser_tabs", `{"action":"new"}`, true},
		{"mcp__browser__browser_tabs", `{"action":"list"}`, false},
		{"mcp__browser__browser_snapshot", `{}`, false},
		{"mcp__computer__click", `{"x":1,"y":2}`, true},
		{"mcp__computer__type_text", `{"text":"hi"}`, true},
		{"mcp__computer__scroll", `{}`, false},
		{"mcp__computer__recognize_text", `{"pid":1,"window_id":2}`, false},
		{"mcp__computer__recognize_text", `{"pid":1,"window_id":2,"pages":1}`, false},
		{"mcp__computer__recognize_text", `{"pid":1,"window_id":2,"pages":4,"next_key":"right"}`, true},
		{"mcp__linger__send_message", `{}`, false},
		{"Bash", `{"command":"ls"}`, false},
	}
	for _, testCase := range cases {
		if got := LocalWriteTool(testCase.tool, testCase.input); got != testCase.write {
			t.Errorf("%s %s: write=%v", testCase.tool, testCase.input, got)
		}
	}
}

func writeManifest(t *testing.T, body string) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, TeamHubCommandManifestFile), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestTeamHubAllowedCommandsAllowsAllowedAndConfirmedCommands(t *testing.T) {
	directory := writeManifest(t, `{"schema_version":2,"commands":[
		{"command":["message","read"],"approval":"allow"},
		{"command":["message","send"],"approval":"allow"},
		{"command":["gmail","search"],"approval":"allow"},
		{"command":["gmail","send"],"approval":"confirm"},
		{"command":["slack","react"],"approval":"judge"},
		{"command":["app","execute"],"approval":"judge"}]}`)
	commands, err := TeamHubAllowedCommands(directory)
	if err != nil {
		t.Fatal(err)
	}
	want := []TeamHubCommand{{Path: []string{"message", "read"}}, {Path: []string{"message", "send"}}, {Path: []string{"gmail", "search"}}, {Path: []string{"gmail", "send"}, Confirm: true}}
	if !reflect.DeepEqual(commands, want) {
		t.Fatalf("commands = %v", commands)
	}
}

func TestTeamHubAllowedCommandsAllowsNothingItCannotRead(t *testing.T) {
	if commands, err := TeamHubAllowedCommands(""); err != nil || commands != nil {
		t.Fatalf("no CLI: %v %v", commands, err)
	}
	// A CLI without its manifest is a broken bundle, not an empty allowlist.
	if commands, err := TeamHubAllowedCommands(t.TempDir()); !errors.Is(err, os.ErrNotExist) || commands != nil {
		t.Fatalf("no manifest: %v %v", commands, err)
	}
	for name, body := range map[string]string{
		"invalid JSON":     `{`,
		"unknown version":  `{"schema_version":1,"commands":[]}`,
		"empty command":    `{"schema_version":2,"commands":[{"command":[],"approval":"allow"}]}`,
		"rule syntax":      `{"schema_version":2,"commands":[{"command":["message","read:*) Bash(curl"],"approval":"allow"}]}`,
		"unknown approval": `{"schema_version":2,"commands":[{"command":["x"],"approval":"maybe"}]}`,
	} {
		if commands, err := TeamHubAllowedCommands(writeManifest(t, body)); err == nil {
			t.Errorf("%s: accepted %v", name, commands)
		}
	}
}
