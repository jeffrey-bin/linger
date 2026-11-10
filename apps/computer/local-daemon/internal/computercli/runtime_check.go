package computercli

import (
	"fmt"
	"strings"
)

var runtimeNames = map[string]string{"codex": "Codex", "claude": "Claude Code", "pi": "Pi"}

var runtimeStatuses = map[string]string{
	"ready":                   "READY",
	"not_installed":           "NOT_INSTALLED",
	"authentication_required": "AUTH_REQUIRED",
	"incompatible":            "INCOMPATIBLE",
	"error":                   "ERROR",
}

// runtimeCheckRow is one Runtime in runtime check output; JSON keeps this
// field order.
type runtimeCheckRow struct {
	Runtime  string `json:"runtime"`
	Name     string `json:"name"`
	Status   string `json:"status"`
	Version  string `json:"version,omitempty"`
	NextStep string `json:"next_step,omitempty"`
	Detail   string `json:"detail,omitempty"`
	// ModelReplyVerified is null when the model reply was not checked.
	ModelReplyVerified *bool `json:"model_reply_verified"`
}

// installStep follows the install guidance on the Web Computer page.
func installStep(runtimeType, goos string) string {
	switch runtimeType {
	case "claude":
		if goos == "windows" {
			return "Install: irm https://claude.ai/install.ps1 | iex"
		}
		return "Install: curl -fsSL https://claude.ai/install.sh | bash"
	case "codex":
		return "Install Codex: https://github.com/openai/codex"
	default:
		return "Install: npm install -g @earendil-works/pi-coding-agent"
	}
}

var signInSteps = map[string]string{
	"codex":  "Run codex login",
	"claude": "Run claude auth login",
	"pi":     "Run pi, then /login",
}

func newRuntimeCheckRow(check runtimeCheck, goos string) runtimeCheckRow {
	diagnostic := check.diagnostic
	name := runtimeNames[diagnostic.Type]
	row := runtimeCheckRow{Runtime: diagnostic.Type, Name: name, Version: diagnostic.Version}
	if diagnostic.Status == "ready" && check.live != nil && !check.live.Passed {
		row.Status = "ERROR"
		row.NextStep = "Check that " + name + " can reach its model"
		row.Detail = check.live.Message
		if row.Detail == "" {
			row.Detail = "The model did not reply"
		}
		row.ModelReplyVerified = new(false)
		return row
	}
	row.Status = runtimeStatuses[diagnostic.Status]
	switch row.Status {
	case "READY":
	case "NOT_INSTALLED":
		row.NextStep = installStep(diagnostic.Type, goos)
	case "AUTH_REQUIRED":
		row.NextStep = signInSteps[diagnostic.Type]
	case "INCOMPATIBLE":
		row.NextStep = "Upgrade " + name
	default:
		row.NextStep = "Fix the error below, then check again"
	}
	if row.Status != "READY" && row.Status != "NOT_INSTALLED" {
		row.Detail = diagnostic.ErrorMessage
	}
	if check.live != nil {
		row.ModelReplyVerified = new(check.live.Passed)
	}
	return row
}

func runtimeCheckExitCode(rows []runtimeCheckRow, single bool) int {
	if !single {
		for _, row := range rows {
			if row.Status == "READY" {
				return 0
			}
		}
		return exitCodes[categoryRuntimeUnavailable]
	}
	switch rows[0].Status {
	case "READY":
		return 0
	case "NOT_INSTALLED":
		return exitCodes[categoryRuntimeUnavailable]
	case "AUTH_REQUIRED":
		return exitCodes[categoryCredential]
	case "INCOMPATIBLE":
		return exitCodes[categoryCapabilityProbe]
	default:
		return exitCodes[categoryInternal]
	}
}

func formatRuntimeProgress(row runtimeCheckRow) string {
	version := ""
	if row.Version != "" {
		version = " (" + row.Version + ")"
	}
	return fmt.Sprintf("  %-13s %s%s\n", row.Name, row.Status, version)
}

func formatRuntimeCheck(rows []runtimeCheckRow, live bool, commandName string) string {
	lines := []string{fmt.Sprintf("%-13s %-15s Next step", "Runtime", "Status")}
	for _, row := range rows {
		next := row.NextStep
		if next == "" {
			next = "—"
		}
		lines = append(lines, fmt.Sprintf("%-13s %-15s %s", row.Name, row.Status, next))
	}
	var details []string
	ready := 0
	for _, row := range rows {
		if row.Detail != "" {
			details = append(details, row.Name+": "+row.Detail)
		}
		if row.Status == "READY" {
			ready++
		}
	}
	if len(details) > 0 {
		lines = append(append(lines, ""), details...)
	}
	lines = append(lines, "")
	switch {
	case len(rows) == 1 && ready == 1:
		lines = append(lines, rows[0].Name+" is ready.")
	case len(rows) == 1:
		lines = append(lines, rows[0].Name+" is not ready.")
	case ready > 0:
		lines = append(lines, fmt.Sprintf("%d/%d runtimes ready. This computer can run agents.", ready, len(rows)))
	default:
		lines = append(lines, fmt.Sprintf("0/%d runtimes ready. Install and sign in to one runtime before running agents.", len(rows)))
	}
	if live {
		if ready > 0 {
			lines = append(lines, "Model reply verified.")
		}
	} else if ready > 0 {
		lines = append(lines, "Model reply not verified. Run "+commandName+" runtime check <name> --live to verify it.")
	}
	return strings.Join(lines, "\n") + "\n"
}
