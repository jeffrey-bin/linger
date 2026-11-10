package externalsource

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

type SlackImportRequest struct {
	ConversationIDs            []string `json:"conversation_ids"`
	Days                       int      `json:"days"`
	MaxMessagesPerConversation int      `json:"max_messages_per_conversation"`
	IncludeThreadReplies       bool     `json:"include_thread_replies"`
}

// TransientImportResult is what one connection import fetched. Status is
// completed, partial, failed, cancelled (the Connection changed while it ran),
// or retry_wait (rate limited: the caller tries again later); a mailbox import
// is also running while its snapshot is still being read.
type TransientImportResult struct {
	Truncated     bool
	Documents     []composio.AppDocument
	Status        string
	LastErrorCode string
	Fetched       int
}

// importRun is one connection import. Nothing about it is stored: its caller
// waits for it, the Connection's active revision fences every write, and the
// fetched documents return to the caller. A mailbox page is the one run a
// River job makes; it keeps its snapshot on the Connection.
type importRun struct {
	ConnectionID, AccountID, TenantID, OwnerActorID, Provider, UpstreamConnectionID string
	ConnectionRevision                                                              int64
	ProviderCallBudget                                                              int
	Request                                                                         json.RawMessage
	CreatedAt                                                                       time.Time
	callsUsed                                                                       atomic.Int64
	mail                                                                            bool
	result                                                                          TransientImportResult
}

// ImportSlack fetches the selected Slack conversations for its caller.
func (s *Service) ImportSlack(ctx context.Context, accountID, tenantID, connectionID string, request SlackImportRequest, budget int) (TransientImportResult, error) {
	if s.provider == nil || len(request.ConversationIDs) == 0 || request.Days < 1 || request.Days > 30 || request.MaxMessagesPerConversation < 1 || budget < 1 {
		return TransientImportResult{}, ErrInvalid
	}
	return s.runImport(ctx, accountID, tenantID, connectionID, "slack", request, budget)
}

// runImport fetches one source of an active Connection and returns what it
// fetched. The returned error is a setup failure (the Connection is missing,
// not active, or the request is invalid); every failure while fetching is the
// result's status.
func (s *Service) runImport(ctx context.Context, accountID, tenantID, connectionID, provider string, request any, budget int) (TransientImportResult, error) {
	connection, err := s.loadAuthorizedProviderConnection(ctx, accountID, tenantID, connectionID, provider)
	if err != nil {
		return TransientImportResult{}, err
	}
	if connection.Status != "active" {
		return TransientImportResult{}, ErrNotActive
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return TransientImportResult{}, ErrInvalid
	}
	job := &importRun{
		ConnectionID: connectionID, AccountID: accountID, TenantID: tenantID, Provider: provider,
		UpstreamConnectionID: connection.UpstreamConnectionID, ConnectionRevision: connection.Revision,
		ProviderCallBudget: budget, Request: encoded, CreatedAt: time.Now().UTC(),
	}
	err = s.executeImport(ctx, job)
	var retry importRetryError
	switch {
	case err == nil, errors.As(err, &retry):
	case errors.Is(err, ErrStaleRevision):
		job.result = TransientImportResult{Status: "cancelled", LastErrorCode: "stale_revision"}
	default:
		s.logger.Warn("connection import failed", "connection_id", connectionID, "provider", provider, "error", err)
		job.result = TransientImportResult{Status: "failed", LastErrorCode: "internal_error"}
	}
	return job.result, nil
}

// AddJobWorkers registers the External Connection workers. Imports other than
// mail have no River job: their callers run them through runImport.
// A job returns without calling Composio while configured reports false.
func AddJobWorkers(workers *river.Workers, service *Service, configured func() bool) {
	jobs.AddWorkerWhen[MailConnectionArgs](workers, configured, &mailConnectionWorker{service: service})
	jobs.AddWorkerWhen[MailImportArgs](workers, configured, &mailImportWorker{service: service})
	jobs.AddWorkerWhen[MailSyncArgs](workers, configured, &mailSyncWorker{service: service})
	jobs.AddWorkerWhen[ReauthorizationArgs](workers, configured, &reauthorizationWorker{service: service})
	jobs.AddWorkerWhen[ConnectionReconcileArgs](workers, configured, &connectionReconcileWorker{service: service})
	jobs.AddWorkerWhen[CleanupArgs](workers, configured, &cleanupWorker{service: service})
}

// importRetryError reports a rate limit: the run is retry_wait and its caller
// runs it again later.
type importRetryError struct {
	code string
}

func (e importRetryError) Error() string {
	return "external import retry: " + e.code
}

func (s *Service) executeImport(ctx context.Context, job *importRun) error {
	switch job.Provider {
	case "slack":
		return s.executeSlackJob(ctx, job)
	case "discord":
		return s.executeDiscordJob(ctx, job)
	case "github":
		return s.executeGitHubJob(ctx, job)
	case "google_calendar":
		return s.executeGoogleCalendarJob(ctx, job)
	case "notion":
		return s.executeNotionJob(ctx, job)
	default:
		return s.failImport(ctx, job, "unsupported_provider")
	}
}

func (s *Service) executeSlackJob(ctx context.Context, job *importRun) error {
	var request SlackImportRequest
	if err := json.Unmarshal(job.Request, &request); err != nil {
		return s.failImport(ctx, job, "invalid_request")
	}
	if job.ProviderCallBudget <= 0 {
		return s.failImport(ctx, job, "provider_call_budget_exhausted")
	}
	identity, err := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.SlackIdentity, error) {
		return s.provider.IdentifySlack(callCtx, job.UpstreamConnectionID)
	})
	if err != nil {
		return s.handleAppProviderError(ctx, job, err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockImportFence(ctx, tx, job); err != nil {
		return err
	}
	identityUpdate, err := tx.Exec(ctx, `UPDATE external_connections SET remote_team_id=$2,remote_team_name=$3,remote_user_id=$4,updated_at=now() WHERE id=$1 AND (remote_team_id IS DISTINCT FROM $2 OR remote_team_name IS DISTINCT FROM $3 OR remote_user_id IS DISTINCT FROM $4)`, job.ConnectionID, identity.TeamID, identity.TeamName, identity.UserID)
	if err != nil {
		return err
	}
	if identityUpdate.RowsAffected() == 1 {
		if err = s.commitAccountExternalConnectionsChange(ctx, tx, job.AccountID); err != nil {
			return err
		}
	} else if err = tx.Commit(ctx); err != nil {
		return err
	}
	pageCursor := ""
	available := map[string]composio.SlackConversation{}
	for {
		page, err := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.SlackConversationPage, error) {
			return s.provider.ListSlackConversations(callCtx, job.UpstreamConnectionID, pageCursor, 200)
		})
		if err != nil {
			return s.handleAppProviderError(ctx, job, err)
		}
		for _, conversation := range page.Conversations {
			available[conversation.ID] = conversation
		}
		if page.NextCursor == "" {
			break
		}
		pageCursor = page.NextCursor
	}
	selected := make([]composio.SlackConversation, 0, len(request.ConversationIDs))
	seen := map[string]bool{}
	for _, id := range request.ConversationIDs {
		conversation, ok := available[id]
		if !ok || seen[id] {
			return s.failImport(ctx, job, "conversation_not_accessible")
		}
		seen[id] = true
		selected = append(selected, conversation)
	}
	type slackFetchResult struct{ documents []composio.SlackDocument }
	fetch, err := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (slackFetchResult, error) {
		documents, _, fetchErr := s.provider.FetchSlackDocuments(callCtx, job.UpstreamConnectionID, identity, selected, composio.SlackImportOptions{Days: request.Days, MaxMessagesPerConversation: request.MaxMessagesPerConversation, IncludeThreadReplies: request.IncludeThreadReplies, MaxProviderCalls: job.ProviderCallBudget, BeforeProviderCall: func(fenceCtx context.Context, _ string) error { return s.requireCurrentImport(fenceCtx, job) }})
		return slackFetchResult{documents: documents}, fetchErr
	})
	if err != nil {
		return s.handleAppProviderError(ctx, job, err)
	}
	documents := make([]composio.AppDocument, 0, len(fetch.documents))
	for _, document := range fetch.documents {
		documents = append(documents, composio.AppDocument{RemoteID: document.RemoteID, Filename: document.Filename, Markdown: document.Markdown})
	}
	return s.commitAppDocuments(ctx, job, documents, false)
}

// requireCurrentImport fails a run whose Connection is no longer the
// active revision it started on.
func (s *Service) requireCurrentImport(ctx context.Context, job *importRun) error {
	var current bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM external_connections WHERE id=$1 AND status='active' AND revision=$2)`, job.ConnectionID, job.ConnectionRevision).Scan(&current); err != nil {
		return err
	}
	if !current {
		return ErrStaleRevision
	}
	return nil
}

// completeImport hands the fetched documents to the waiting caller. A
// partial fetch skipped part of the source.
func (s *Service) completeImport(ctx context.Context, job *importRun, documents []composio.AppDocument, fetched int, partial bool) error {
	if err := s.requireCurrentImport(ctx, job); err != nil {
		return err
	}
	job.result = TransientImportResult{Status: "completed", Documents: documents, Fetched: fetched}
	if partial {
		job.result.Status, job.result.LastErrorCode = "partial", "secondary_page_failed"
	}
	return nil
}

// lockImportFence locks the run's Connection while it is still the active
// revision the run started on.
func lockImportFence(ctx context.Context, tx pgx.Tx, job *importRun) error {
	var locked bool
	err := tx.QueryRow(ctx, `SELECT true FROM external_connections WHERE id=$1 AND account_id=$2 AND status='active' AND revision=$3 FOR UPDATE`, job.ConnectionID, job.AccountID, job.ConnectionRevision).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrStaleRevision
	}
	return err
}

// retryImport settles a provider failure. A rate limit makes the run retry_wait
// and returns importRetryError; anything else fails it.
func (s *Service) retryImport(ctx context.Context, job *importRun, cause error) error {
	code, terminal := importRetryPolicy(cause)
	if terminal {
		return s.failImport(ctx, job, code)
	}
	job.result = TransientImportResult{Status: "retry_wait", LastErrorCode: code}
	return importRetryError{code: code}
}

// importRetryPolicy maps a provider failure to its error code. Only a rate
// limit is not terminal: the caller retries it.
func importRetryPolicy(cause error) (code string, terminal bool) {
	if composio.IsAuthFailure(cause) {
		return "provider_auth_failed", true
	}
	var limited *composio.RateLimitError
	if errors.As(cause, &limited) {
		return "provider_rate_limited", false
	}
	return "provider_unavailable", true
}

// failImport ends a run with code. A failed mailbox snapshot is recorded on its
// Connection, so the next caller sees it.
func (s *Service) failImport(ctx context.Context, job *importRun, code string) error {
	if job.mail {
		return s.failMailImport(context.WithoutCancel(ctx), job.ConnectionID, job.ConnectionRevision, code)
	}
	job.result = TransientImportResult{Status: "failed", LastErrorCode: code}
	return nil
}

func durationInterval(value time.Duration) string {
	microseconds := value.Microseconds()
	if value > 0 && microseconds == 0 {
		microseconds = 1
	}
	return strconv.FormatInt(microseconds, 10) + " microseconds"
}
func (s *Service) loadAuthorizedProviderConnection(ctx context.Context, accountID, tenantID, connectionID, provider string) (Connection, error) {
	connection, err := s.loadAuthorizedConnection(ctx, accountID, tenantID, connectionID)
	if err != nil {
		return Connection{}, err
	}
	if connection.Provider != provider {
		return Connection{}, ErrNotFound
	}
	return connection, nil
}
