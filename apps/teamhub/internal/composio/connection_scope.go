package composio

import (
	"context"
	"errors"
	"regexp"
)

var ErrConnectionScope = errors.New("connected app does not belong to this environment")
var environmentKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var appKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,119}$`)

func ValidAppKey(value string) bool { return appKeyPattern.MatchString(value) }

type ConnectionBinding struct {
	UserID, ToolkitSlug, AuthConfigID string
}

// ConnectionAuthority resolves the immutable upstream receipt from TeamHub.
// It must reject receipts from another deployment before any provider request.
type ConnectionAuthority func(context.Context, string) (ConnectionBinding, error)

func (c *Client) SetConnectionAuthority(authority ConnectionAuthority) {
	c.connectionAuthority = authority
}

func (c *Client) UserIDForAccount(accountID string) string {
	return "linger:" + c.environmentKey + ":account:" + accountID
}

// AuthConfigName is the stable name TeamHub finds or creates the auth config
// of toolkit under.
func (c *Client) AuthConfigName(toolkit, scheme string) string {
	return "linger:" + c.environmentKey + ":" + toolkit + ":" + scheme + ":v1"
}

func (c *Client) authorizeConnection(ctx context.Context, upstreamID string) (ConnectionBinding, error) {
	if c.connectionAuthority == nil {
		return ConnectionBinding{}, ErrConnectionScope
	}
	return c.connectionAuthority(ctx, upstreamID)
}
