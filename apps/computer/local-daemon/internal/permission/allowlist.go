package permission

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// readOnlyLocalTools are the Daemon's own browser and desktop tools whose
// effect stays on this screen: reading it, or moving the pointer, scrolling,
// hovering, going back a page, and arranging windows. Clicking, typing, keys,
// dragging, navigation to a new address, uploads, and dialogs are judged.
// recognize_text is read-only only for one page: a paged read presses its
// next_key between pages. report_blocker stops the task's own input to the
// Computer's own browser, and rate_limited also cools the site down there for
// every task on this Computer.
var readOnlyLocalTools = map[string]bool{
	"mcp__browser__browser_snapshot":         true,
	"mcp__browser__browser_take_screenshot":  true,
	"mcp__browser__browser_console_messages": true,
	"mcp__browser__browser_network_requests": true,
	"mcp__browser__browser_wait_for":         true,
	"mcp__browser__browser_hover":            true,
	"mcp__browser__browser_resize":           true,
	"mcp__browser__browser_navigate_back":    true,
	"mcp__computer__list_windows":            true,
	"mcp__computer__get_window_state":        true,
	"mcp__computer__get_desktop_state":       true,
	"mcp__computer__clipboard_read":          true,
	"mcp__computer__scroll":                  true,
	"mcp__computer__move_cursor":             true,
	"mcp__computer__bring_to_front":          true,
	"mcp__computer__set_window_frame":        true,
	"mcp__computer__check_permissions":       true,
	"mcp__computer__report_blocker":          true,
}

// ReadOnlyLocalToolNames lists the names in readOnlyLocalTools, for adapters
// that declare them to their Runtime and for tests that keep the list in step
// with the local tool catalog.
func ReadOnlyLocalToolNames() []string {
	names := make([]string, 0, len(readOnlyLocalTools))
	for name := range readOnlyLocalTools {
		names = append(names, name)
	}
	return names
}

// ReadOnlyLocalTool reports whether the call is one of the Daemon's own
// read-only local tools. input is the tool input as JSON.
func ReadOnlyLocalTool(tool, input string) bool {
	if readOnlyLocalTools[tool] {
		return true
	}
	if tool == "mcp__computer__recognize_text" {
		var arguments struct {
			Pages int `json:"pages"`
		}
		return json.Unmarshal([]byte(input), &arguments) == nil && arguments.Pages <= 1
	}
	if tool == "mcp__browser__browser_tabs" {
		// Listing tabs and switching to an open one change nothing; opening
		// and closing tabs are judged.
		var arguments struct {
			Action string `json:"action"`
		}
		return json.Unmarshal([]byte(input), &arguments) == nil && (arguments.Action == "list" || arguments.Action == "select")
	}
	return false
}

// LocalWriteTool reports whether the call is a browser or desktop action
// that is not read-only. Adapters route these to the review even if a
// Runtime rule would otherwise allow them.
func LocalWriteTool(tool, input string) bool {
	return (strings.HasPrefix(tool, "mcp__browser__") || strings.HasPrefix(tool, "mcp__computer__")) && !ReadOnlyLocalTool(tool, input)
}

// TeamHubCommandManifestFile is written beside the bundled TeamHub CLI by the
// CLI build. It is host metadata, not a CLI command.
const TeamHubCommandManifestFile = "teamhub-commands.json"

var commandPart = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// TeamHubCommand is a TeamHub CLI command path that runs without review.
type TeamHubCommand struct {
	Path []string
	// Confirm marks a command whose write waits for the sponsor's TeamHub
	// confirmation card when it needs approval.
	Confirm bool
}

// TeamHubAllowedCommands returns the TeamHub CLI command paths that run
// without review: the manifest's "allow" commands (reads, TeamHub's own
// collaboration writes, and connector writes nobody else sees) and its
// "confirm" commands, whose write waits for the sponsor's TeamHub
// confirmation card when it needs approval (connector writes; Agent creation
// and changes). "judge" commands, including the generic app
// tool, are reviewed. A missing or invalid manifest returns no commands, so
// every TeamHub command is judged instead of guessed.
func TeamHubAllowedCommands(cliDirectory string) ([]TeamHubCommand, error) {
	if cliDirectory == "" {
		return nil, nil
	}
	// A bundled CLI always ships its manifest. Missing it would silently send
	// every TeamHub command to review, so it is an error.
	raw, err := os.ReadFile(filepath.Join(cliDirectory, TeamHubCommandManifestFile))
	if err != nil {
		return nil, err
	}
	var manifest struct {
		SchemaVersion int `json:"schema_version"`
		Commands      []struct {
			Command  []string `json:"command"`
			Approval string   `json:"approval"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	if manifest.SchemaVersion != 2 {
		return nil, errors.New("unsupported TeamHub command manifest version")
	}
	var allowed []TeamHubCommand
	for _, entry := range manifest.Commands {
		if len(entry.Command) == 0 {
			return nil, errors.New("TeamHub command manifest has an empty command")
		}
		for _, part := range entry.Command {
			if !commandPart.MatchString(part) {
				return nil, errors.New("TeamHub command manifest has an invalid command")
			}
		}
		switch entry.Approval {
		case "allow", "confirm":
			allowed = append(allowed, TeamHubCommand{Path: entry.Command, Confirm: entry.Approval == "confirm"})
		case "judge":
		default:
			return nil, errors.New("TeamHub command manifest has an unknown approval")
		}
	}
	return allowed, nil
}
