package provider

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

// LiveCheck records whether a ready Runtime returned a model reply. Discovery
// only proves the local install, version, sign-in, and protocol.
type LiveCheck struct {
	Passed     bool   `json:"passed"`
	Reply      string `json:"reply,omitempty"`
	Message    string `json:"message,omitempty"`
	DurationMS int64  `json:"duration_ms"`
}

const liveCheckPrompt = "Reply with exactly: OK"

var liveCheckArgs = map[string][]string{
	"codex":  {"exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never", liveCheckPrompt},
	"claude": {"-p", liveCheckPrompt, "--output-format", "text"},
	"pi":     {"-p", liveCheckPrompt},
}

// DiscoverLive diagnoses the selected Runtimes and sends each ready one a
// fixed prompt through its own non-interactive mode.
func DiscoverLive(ctx context.Context, options DiscoveryOptions, timeout time.Duration) (DiscoveryResult, map[string]LiveCheck) {
	options.Environment = terminalEnvironment(ctx, platformEnvironment(options.Environment))
	result := discoverResolved(ctx, options)
	checks := make(map[string]LiveCheck, len(result.Diagnostics))
	var lock sync.Mutex
	var workers sync.WaitGroup
	for _, diagnostic := range result.Diagnostics {
		if diagnostic.Status != "ready" {
			continue
		}
		workers.Go(func() {
			check := checkLive(ctx, diagnostic, options.Environment, timeout)
			lock.Lock()
			checks[diagnostic.Type] = check
			lock.Unlock()
		})
	}
	workers.Wait()
	return result, checks
}

func checkLive(ctx context.Context, diagnostic RuntimeDiagnostic, environment map[string]string, timeout time.Duration) LiveCheck {
	started := time.Now()
	stdout, stderr, err := runBoundedProbeExchange(ctx, diagnostic.ExecutablePath, liveCheckArgs[diagnostic.Type], environment, "", timeout, nil)
	check := LiveCheck{DurationMS: time.Since(started).Milliseconds(), Reply: truncateRunes(redact.Text(strings.TrimSpace(stdout)), 200)}
	switch {
	case err != nil && ctx.Err() == nil && time.Since(started) >= timeout:
		check.Message = "Runtime did not reply within " + timeout.String()
	case err != nil:
		check.Message = liveFailureMessage(stderr, err)
	case check.Reply == "":
		check.Message = "Runtime exited without a reply"
	default:
		check.Passed = true
	}
	return check
}

func liveFailureMessage(stderr string, err error) string {
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		if line := strings.TrimSpace(lines[index]); line != "" {
			return truncateRunes(redact.Text(line), 300)
		}
	}
	return truncateRunes(redact.Text(err.Error()), 300)
}
