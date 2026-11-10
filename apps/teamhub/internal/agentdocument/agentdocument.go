// Package agentdocument serves the Agent CLI Document tools: comment replies
// and text replacement, Document creation and semantic mutation. Each tool
// authorizes the Agent invocation through agentauth before calling document.
package agentdocument

import (
	"context"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
)

type contextAuthorizer interface {
	Authorize(context.Context, string, string) (agentauth.Authorization, error)
}

func validInvocationID(value string) bool {
	const prefix = "agent-invocation-sha256:"
	if len(value) != len(prefix)+64 || !strings.HasPrefix(value, prefix) {
		return false
	}
	for index := len(prefix); index < len(value); index++ {
		if (value[index] < '0' || value[index] > '9') && (value[index] < 'a' || value[index] > 'f') {
			return false
		}
	}
	return true
}
