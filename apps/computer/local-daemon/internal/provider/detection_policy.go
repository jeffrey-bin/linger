package provider

import (
	"context"
	"time"
)

// runtimeDetectionPolicy decides how discovery checks each Runtime. The Daemon
// and the CLI's setup and doctor share this one implementation.
type runtimeDetectionPolicy struct {
	// authenticationProbe asks the Runtime who is signed in. Nil means this
	// Runtime has no way to tell us, and readiness rests on protocol alone.
	authenticationProbe func(context.Context, string, map[string]string, time.Duration) runtimeProbeOutcome
	// authenticationBeforeProtocol reaches the authentication verdict first and
	// returns it without a handshake. Claude answers out of band, so a signed-out
	// CLI is reported as needing a login rather than as an incompatible
	// protocol; Codex reads the account inside the app-server session it has
	// already opened, so its handshake necessarily comes first.
	authenticationBeforeProtocol bool
	// authenticationRefresh re-probes authentication on the periodic refresh
	// without repeating discovery.
	authenticationRefresh bool
}

var runtimeDetectionPolicies = map[string]runtimeDetectionPolicy{
	"codex": {
		authenticationProbe:   probeCodexAuthentication,
		authenticationRefresh: true,
	},
	"claude": {
		authenticationProbe:          probeClaudeAuthentication,
		authenticationBeforeProtocol: true,
		authenticationRefresh:        true,
	},
	"pi": {authenticationProbe: probePiAuthentication, authenticationRefresh: true},
}
