package agentdocument

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
)

type fakeAuthorizer struct {
	authorize func(context.Context, string, string) (agentauth.Authorization, error)
}

func (f fakeAuthorizer) Authorize(ctx context.Context, token, tool string) (agentauth.Authorization, error) {
	return f.authorize(ctx, token, tool)
}
