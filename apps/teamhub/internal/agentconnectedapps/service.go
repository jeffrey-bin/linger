package agentconnectedapps

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

const (
	uncertainExecutionMessage = "The connected app tool result is uncertain and must not be retried automatically"
	// pinnedToolTTL is how long a fetched tool version is reused before
	// Composio is asked again whether it is still served.
	pinnedToolTTL = 10 * time.Minute
	// maxSearchLimit is the most tools Composio discovery returns per search.
	maxSearchLimit = 50
)

var (
	ErrInvalid          = errors.New("invalid Connected Apps request")
	errToolNotFound     = errors.New("connected app tool was not found")
	connectionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	toolSlugPattern     = regexp.MustCompile(`^[A-Z0-9][A-Z0-9_]{1,199}$`)
	toolVersionPattern  = regexp.MustCompile(`^[0-9]{8}_[0-9]{2}$`)
	operationIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

type connectionAuthority interface {
	ListGrantedAgentToolConnectionsInTx(context.Context, pgx.Tx, string, string, string, string) ([]externalsource.AgentToolConnection, error)
	LockGrantedAgentToolConnectionInTx(context.Context, pgx.Tx, string, string, string) (externalsource.AgentToolConnection, error)
	SetAutoRemindersTx(context.Context, pgx.Tx, string, string, bool) error
}

type ToolProvider interface {
	SearchTools(context.Context, composio.ToolSearchRequest) ([]composio.Tool, error)
	GetTool(context.Context, string, string) (composio.Tool, error)
	ExecuteTool(context.Context, string, string, string, string, map[string]any) (composio.ToolExecution, error)
	GetConnectionStatusForToolkit(context.Context, string, string) (composio.ConnectionStatus, error)
}

type Service struct {
	pool        *pgxpool.Pool
	contexts    *agentauth.Service
	connections connectionAuthority
	provider    ToolProvider
	logger      *slog.Logger
	// pinnedTools keeps fetched tool versions for pinnedToolTTL; every call
	// otherwise waits on the same Composio lookup before it runs.
	pinnedTools sync.Map
}

type fetchedTool struct {
	tool    composio.Tool
	fetched time.Time
}

type ConnectedApp struct {
	ConnectionID string
	AppKey       string
	DisplayName  string
	Identity     string
}

type AppTool struct {
	ToolSlug             string
	ToolVersion          string
	Name                 string
	Description          string
	AppKey               string
	InputSchema          map[string]any
	AvailableConnections []ConnectedApp
}

type SearchInput struct {
	Query        string
	ConnectionID string
	AppKey       string
	Limit        int
}

type ExecuteInput struct {
	ConnectionID string
	ToolSlug     string
	ToolVersion  string
	Arguments    map[string]any
}

type Error struct {
	Code      string
	Message   string
	Retryable bool
	// Issues name the exact request field at fault, such as a pinned tool
	// version Composio no longer serves.
	Issues []Issue
	cause  error
}

// Issue is one model-safe detail of an Error.
type Issue struct{ Path, Code, Message string }

func (err *Error) Error() string { return err.Message }
func (err *Error) Unwrap() error { return err.cause }

func New(pool *pgxpool.Pool, contexts *agentauth.Service, connections connectionAuthority, provider ToolProvider) *Service {
	return &Service{pool: pool, contexts: contexts, connections: connections, provider: provider, logger: slog.Default()}
}

func (s *Service) SetLogger(logger *slog.Logger) {
	if logger != nil {
		s.logger = logger
	}
}

type operationIDKey struct{}

// WithOperationID carries the CLI's operation ID into the call log.
func WithOperationID(ctx context.Context, operationID string) context.Context {
	if !operationIDPattern.MatchString(operationID) {
		return ctx
	}
	return context.WithValue(ctx, operationIDKey{}, operationID)
}

// logCall writes one line for each external call: which Agent used which
// account for what, and how it ended. It is an audit trail only: it neither
// deduplicates nor rate limits.
func (s *Service) logCall(ctx context.Context, call string, connection externalsource.AgentToolConnection, slug, version, outcome string, extra ...any) {
	operationID, _ := ctx.Value(operationIDKey{}).(string)
	logger := s.logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.InfoContext(ctx, "connected app call", append([]any{
		"call", call, "agent_actor_id", connection.AgentActorID, "connection_id", connection.ID,
		"app_key", connection.AppKey, "tool_slug", slug, "tool_version", version,
		"operation_id", operationID, "outcome", outcome,
	}, extra...)...)
}

// resultOutcome names how a call ended for the call log. A held call has not
// run; whether its card was posted is the caller's to log.
func resultOutcome(result Result, err error) string {
	if err == nil && result.Confirmation != nil {
		return "held_for_confirmation"
	}
	return callOutcome(err)
}

// issueCodes adds a failed call's issue codes to the call log, so a reason
// such as an oversized response is visible without the provider's text.
func issueCodes(err error) []any {
	var domain *Error
	if !errors.As(err, &domain) || len(domain.Issues) == 0 {
		return nil
	}
	codes := make([]string, 0, len(domain.Issues))
	for _, issue := range domain.Issues {
		codes = append(codes, issue.Code)
	}
	return []any{"issue_codes", codes}
}

// callOutcome names how a call ended for the call log.
func callOutcome(err error) string {
	var domain *Error
	switch {
	case err == nil:
		return "succeeded"
	case errors.As(err, &domain):
		return domain.Code
	default:
		return "error"
	}
}

func (s *Service) List(ctx context.Context, token string) ([]ConnectedApp, error) {
	if s == nil || s.pool == nil || s.contexts == nil || s.connections == nil {
		return nil, unavailableError(nil)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	authorization, err := s.contexts.AuthorizeInTx(ctx, tx, token, "list_connected_apps")
	if err != nil {
		return nil, err
	}
	connections, err := s.connections.ListGrantedAgentToolConnectionsInTx(
		ctx, tx, authorization.AgentActorID, authorization.TenantID, "", "",
	)
	if err != nil {
		return nil, err
	}
	result := make([]ConnectedApp, 0, len(connections))
	for _, connection := range connections {
		result = append(result, publicConnection(connection))
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) Search(ctx context.Context, token string, input SearchInput) ([]AppTool, error) {
	ctx, cancel := context.WithTimeout(ctx, 55*time.Second)
	defer cancel()
	input.Query = strings.TrimSpace(input.Query)
	input.ConnectionID = strings.TrimSpace(input.ConnectionID)
	input.AppKey = strings.TrimSpace(input.AppKey)
	if input.Limit == 0 {
		input.Limit = 20
	}
	if input.Query == "" || utf8.RuneCountInString(input.Query) > 200 || input.Limit < 1 || input.Limit > maxSearchLimit ||
		(input.ConnectionID != "" && !connectionIDPattern.MatchString(input.ConnectionID)) ||
		(input.AppKey != "" && !composio.ValidAppKey(input.AppKey)) {
		return nil, ErrInvalid
	}
	if s == nil || s.pool == nil || s.contexts == nil || s.connections == nil || s.provider == nil {
		return nil, unavailableError(nil)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	authorization, err := s.contexts.AuthorizeInTx(ctx, tx, token, "search_app_tools")
	if err != nil {
		return nil, err
	}
	connections, err := s.connections.ListGrantedAgentToolConnectionsInTx(
		ctx, tx, authorization.AgentActorID, authorization.TenantID,
		input.ConnectionID, input.AppKey,
	)
	if err != nil {
		return nil, err
	}
	if len(connections) == 0 {
		return nil, &Error{Code: "app_not_connected", Message: "No active delegated connected app matches this search"}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	activeConnections := make([]externalsource.AgentToolConnection, 0, len(connections))
	for _, connection := range connections {
		status, statusErr := s.provider.GetConnectionStatusForToolkit(ctx, connection.UpstreamConnectionID, connection.ToolkitSlug)
		if statusErr != nil {
			return nil, mapToolError(&providerOperationError{phase: "connection_status", err: statusErr}, "search")
		}
		if status == composio.ConnectionActive {
			activeConnections = append(activeConnections, connection)
		}
	}
	if len(activeConnections) == 0 {
		return nil, &Error{Code: "app_not_connected", Message: "No active delegated connected app matches this search"}
	}
	return s.searchTools(ctx, activeConnections, input.Query, input.Limit)
}

// Execute runs one tool call, or holds a write that needs the sponsor's
// confirmation and returns its card instead (see accessOf).
func (s *Service) Execute(ctx context.Context, token string, input ExecuteInput) (Result, error) {
	input.ConnectionID = strings.TrimSpace(input.ConnectionID)
	input.ToolSlug = strings.TrimSpace(input.ToolSlug)
	input.ToolVersion = strings.TrimSpace(input.ToolVersion)
	if !connectionIDPattern.MatchString(input.ConnectionID) || !toolSlugPattern.MatchString(input.ToolSlug) ||
		!toolVersionPattern.MatchString(input.ToolVersion) || input.Arguments == nil {
		return Result{}, ErrInvalid
	}
	if s == nil || s.pool == nil || s.contexts == nil || s.connections == nil || s.provider == nil {
		return Result{}, unavailableError(nil)
	}
	return s.execute(ctx, input, func(ctx context.Context) (externalsource.AgentToolConnection, error) {
		return s.authorizeExecution(ctx, token, input.ConnectionID)
	})
}

// execute runs a validated call under the Agent's current authority over the
// connection, which authorize checks.
func (s *Service) execute(ctx context.Context, input ExecuteInput, authorize func(context.Context) (externalsource.AgentToolConnection, error)) (result Result, err error) {
	connection, err := authorize(ctx)
	if err != nil {
		return Result{}, err
	}
	defer func() {
		s.logCall(ctx, "tools/execute", connection, input.ToolSlug, input.ToolVersion, resultOutcome(result, err), issueCodes(err)...)
	}()
	if err := s.checkConnectionActive(ctx, connection); err != nil {
		return Result{}, err
	}
	if _, err := s.pinnedTool(ctx, connection, input.ToolSlug, input.ToolVersion, "execute"); err != nil {
		return Result{}, err
	}
	if accessOf(input.ToolSlug) == accessConfirm {
		return s.prepareConfirmation(ctx, connection, confirmationAction{
			ToolSlug: input.ToolSlug, ToolVersion: input.ToolVersion, Arguments: input.Arguments,
		})
	}
	// Revalidate Agent authority immediately before admission, including the exact connection
	// revision that was checked upstream. No network call holds database locks.
	current, err := authorize(ctx)
	if err != nil {
		return Result{}, err
	}
	if current != connection {
		return Result{}, mapToolError(externalsource.ErrNotActive, "execute")
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	execution, err := s.provider.ExecuteTool(
		ctx, connection.UpstreamConnectionID, connection.UserID,
		input.ToolSlug, input.ToolVersion, input.Arguments,
	)
	if err != nil {
		return Result{}, dispatchedError(err)
	}
	if !execution.Successful {
		// Still uncertain, since the CLI must not replay it, but with the
		// provider's own reason; the CLI shows issues, not messages.
		uncertain := uncertainExecutionError(nil)
		if detail := providerErrorText(execution.Error); detail != "" {
			uncertain.Message += ". The connected application reported: " + detail
			uncertain.Issues = []Issue{{Path: "provider", Code: "provider_error", Message: detail}}
		}
		return Result{}, uncertain
	}
	return Result{Data: sanitizeValue(execution.Data)}, nil
}

// pinnedTool fetches the exact tool version a caller pinned. Callers never
// switch to another version, so a version Composio no longer serves or has
// deprecated is reported as such: the CLI's version pin needs an upgrade.
func (s *Service) pinnedTool(ctx context.Context, connection externalsource.AgentToolConnection, slug, version, operation string) (composio.Tool, error) {
	tool, err := s.fetchTool(ctx, slug, version)
	if status, ok := composio.ErrorStatus(err); ok && status == http.StatusNotFound {
		return composio.Tool{}, versionUnavailableError(slug, version, err)
	}
	if err != nil {
		return composio.Tool{}, mapToolError(&providerOperationError{phase: "get_tool", err: err}, operation)
	}
	if tool.Slug != slug || tool.Toolkit.Slug != connection.ToolkitSlug || !appAllowsTool(connection.AppKey, slug) {
		return composio.Tool{}, mapToolError(errToolNotFound, operation)
	}
	if tool.IsDeprecated || tool.Version != version {
		return composio.Tool{}, versionUnavailableError(slug, version, nil)
	}
	return tool, nil
}

// fetchTool reads one tool version, reusing a fetch younger than
// pinnedToolTTL; failed fetches are not kept.
func (s *Service) fetchTool(ctx context.Context, slug, version string) (composio.Tool, error) {
	key := slug + "@" + version
	if cached, ok := s.pinnedTools.Load(key); ok && time.Since(cached.(fetchedTool).fetched) < pinnedToolTTL {
		return cached.(fetchedTool).tool, nil
	}
	tool, err := s.provider.GetTool(ctx, slug, version)
	if err == nil {
		s.pinnedTools.Store(key, fetchedTool{tool: tool, fetched: time.Now()})
	}
	return tool, err
}

// versionUnavailableError keeps tool_not_found, which the CLI records as a
// rejected operation, and says which pin to upgrade.
func versionUnavailableError(slug, version string, cause error) *Error {
	message := fmt.Sprintf("The pinned version %s of %s is no longer available; upgrade the CLI connector version pin", version, slug)
	return &Error{Code: "tool_not_found", Message: message, Issues: []Issue{{Path: "tool_version", Code: "tool_version_unavailable", Message: message}}, cause: cause}
}

// Commit is the admission boundary. Revocation blocks later admissions; an
// admitted external operation may already have effects and must not be replayed.
func (s *Service) authorizeExecution(ctx context.Context, token string, connectionID string) (externalsource.AgentToolConnection, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return externalsource.AgentToolConnection{}, err
	}
	defer tx.Rollback(ctx)
	authorization, err := s.contexts.AuthorizeInTx(ctx, tx, token, "execute_app_tool")
	if err != nil {
		return externalsource.AgentToolConnection{}, err
	}
	connection, err := s.connections.LockGrantedAgentToolConnectionInTx(ctx, tx, authorization.AgentActorID, authorization.TenantID, connectionID)
	if err != nil {
		return externalsource.AgentToolConnection{}, mapToolError(err, "execute")
	}
	if err := tx.Commit(ctx); err != nil {
		return externalsource.AgentToolConnection{}, err
	}
	return connection, nil
}

// searchTools searches once per app, not per toolkit: two apps can share a
// toolkit (Outlook and Outlook Calendar) yet offer different tools.
func (s *Service) searchTools(ctx context.Context, connections []externalsource.AgentToolConnection, query string, limit int) ([]AppTool, error) {
	byApp := make(map[string][]externalsource.AgentToolConnection)
	apps := make([]string, 0, len(connections))
	for _, connection := range connections {
		if _, ok := byApp[connection.AppKey]; !ok {
			apps = append(apps, connection.AppKey)
		}
		byApp[connection.AppKey] = append(byApp[connection.AppKey], connection)
	}
	sort.Strings(apps)
	candidates := make(map[string][]AppTool, len(apps))
	for _, app := range apps {
		connection := byApp[app][0]
		toolkit := connection.ToolkitSlug
		searchLimit := limit
		if _, scoped := appToolScopes[app]; scoped {
			// Part of what the toolkit returns falls outside the app.
			searchLimit = maxSearchLimit
		}
		found, err := s.provider.SearchTools(ctx, composio.ToolSearchRequest{
			UserID: connection.UserID, ConnectedAccountID: connection.UpstreamConnectionID,
			ToolkitSlug: toolkit, Query: query, Limit: searchLimit,
		})
		if err != nil {
			return nil, mapToolError(err, "search")
		}
		for _, tool := range found {
			if len(candidates[app]) >= limit {
				break
			}
			if tool.IsDeprecated || tool.Toolkit.Slug != toolkit || !toolSlugPattern.MatchString(tool.Slug) ||
				!toolVersionPattern.MatchString(tool.Version) || !appAllowsTool(app, tool.Slug) {
				continue
			}
			available := make([]ConnectedApp, 0, len(byApp[app]))
			for _, connection := range byApp[app] {
				available = append(available, publicConnection(connection))
			}
			candidates[app] = append(candidates[app], AppTool{
				ToolSlug: tool.Slug, ToolVersion: tool.Version, Name: tool.Name,
				Description: tool.Description, AppKey: app,
				InputSchema:          sanitizeMap(tool.InputParameters),
				AvailableConnections: available,
			})
		}
	}
	tools := make([]AppTool, 0, limit)
	for index := 0; len(tools) < limit; index++ {
		added := false
		for _, app := range apps {
			if index >= len(candidates[app]) {
				continue
			}
			tools = append(tools, candidates[app][index])
			added = true
			if len(tools) == limit {
				break
			}
		}
		if !added {
			break
		}
	}
	return tools, nil
}

func publicConnection(connection externalsource.AgentToolConnection) ConnectedApp {
	return ConnectedApp{
		ConnectionID: connection.ID, AppKey: connection.AppKey,
		DisplayName: connection.DisplayName, Identity: connection.IdentityLabel,
	}
}

type providerOperationError struct {
	phase string
	err   error
}

func (err *providerOperationError) Error() string { return err.err.Error() }
func (err *providerOperationError) Unwrap() error { return err.err }

func uncertainExecutionError(cause error) *Error {
	return &Error{Code: "tool_execution_failed", Message: uncertainExecutionMessage, cause: cause}
}

// dispatchedError is a failed execution after dispatch. An oversized response
// names its reason, since asking for fewer items at a time avoids it.
func dispatchedError(cause error) *Error {
	err := uncertainExecutionError(cause)
	if errors.Is(cause, composio.ErrResponseTooLarge) {
		err.Issues = []Issue{{Path: "provider", Code: "response_too_large",
			Message: "The connected application's response is larger than TeamHub reads; request fewer items at a time"}}
	}
	return err
}

func unavailableError(cause error) *Error {
	return &Error{Code: "provider_unavailable", Message: "Connected app tools are unavailable", Retryable: true, cause: cause}
}

func mapToolError(err error, operation string) *Error {
	switch {
	case errors.Is(err, ErrInvalid), errors.Is(err, externalsource.ErrInvalid):
		return &Error{Code: "invalid_input", Message: "Connected app tool input is invalid", cause: err}
	case errors.Is(err, externalsource.ErrNotFound):
		return &Error{Code: "connection_not_found", Message: "The selected connected app was not found", cause: err}
	case errors.Is(err, externalsource.ErrNotActive):
		return &Error{Code: "connection_not_active", Message: "The selected connected app is not active", cause: err}
	case errors.Is(err, composio.ErrToolDiscovery):
		return unavailableError(err)
	case errors.Is(err, errToolNotFound):
		return &Error{Code: "tool_not_found", Message: "The selected connected app tool was not found", cause: err}
	}
	var providerErr *providerOperationError
	_ = errors.As(err, &providerErr)
	var rateLimit *composio.RateLimitError
	if errors.As(err, &rateLimit) {
		return &Error{Code: "provider_rate_limited", Message: "The connected app provider rate limited this request", Retryable: true, cause: err}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &Error{Code: "provider_unavailable", Message: "The connected app provider is unavailable", Retryable: true, cause: err}
	}
	if status, ok := composio.ErrorStatus(err); ok {
		switch {
		case providerErr != nil && providerErr.phase == "connection_status" &&
			(status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusNotFound || status == http.StatusGone):
			return &Error{Code: "provider_auth_failed", Message: "The connected app authorization is no longer valid", cause: err}
		case status == http.StatusNotFound && operation != "execute":
			return &Error{Code: "tool_not_found", Message: "The selected connected app tool was not found", cause: err}
		case operation == "execute" && (status == http.StatusBadRequest || status == http.StatusUnprocessableEntity):
			return &Error{Code: "invalid_tool_arguments", Message: "The connected app tool arguments are invalid", cause: err}
		case operation == "execute" && (status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusGone):
			return &Error{Code: "provider_auth_failed", Message: "The connected app authorization is no longer valid", cause: err}
		case status == http.StatusTooManyRequests:
			return &Error{Code: "provider_rate_limited", Message: "The connected app provider rate limited this request", Retryable: true, cause: err}
		case status == http.StatusRequestTimeout || status >= 500:
			return &Error{Code: "provider_unavailable", Message: "The connected app provider is unavailable", Retryable: true, cause: err}
		case operation == "execute":
			return &Error{Code: "tool_execution_failed", Message: "The connected app tool did not complete successfully", cause: err}
		default:
			return unavailableError(err)
		}
	}
	return &Error{Code: "internal_error", Message: "TeamHub could not complete the connected app operation", Retryable: true, cause: err}
}

func sanitizeMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	sanitized, _ := sanitizeValue(value).(map[string]any)
	return sanitized
}

func sanitizeValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			if sensitiveKey(key) {
				continue
			}
			result[key] = sanitizeValue(item)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = sanitizeValue(item)
		}
		return result
	default:
		return value
	}
}

func sensitiveKey(key string) bool {
	normalized := strings.Map(func(character rune) rune {
		if character >= 'A' && character <= 'Z' {
			return character + ('a' - 'A')
		}
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			return character
		}
		return -1
	}, key)
	switch normalized {
	case "connectedaccount", "connectedaccountid", "authconfig", "authconfigid", "apikey", "accesstoken", "refreshtoken", "oauthtoken",
		"bearertoken", "authorization", "credential", "credentials", "clientsecret", "password":
		return true
	default:
		return false
	}
}
