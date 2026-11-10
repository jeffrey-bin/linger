package externalsource

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

func IsMailProvider(provider string) bool { return provider == "gmail" || provider == "outlook" }

// MailWikiSource is one imported message promoted into the owner's Personal Wiki.
type MailWikiSource struct {
	TenantID, OwnerActorID, SourceKey, Filename string
	Content                                     []byte
}

// MailImported names a mailbox snapshot that just completed.
type MailImported struct {
	TenantID, OwnerActorID, ConnectionID string
	Revision                             int64
}

// SetMailImport wires the Wiki source writer and the hook run in the
// transaction that settles the last mail page. A new mailbox's snapshot
// starts its Wiki at once; later mail waits for the night.
func (s *Service) SetMailImport(writeWikiSource func(context.Context, MailWikiSource) error, imported func(context.Context, pgx.Tx, MailImported) error) {
	s.writeMailWikiSource = writeWikiSource
	s.mailImported = imported
}

// MailConnectionArgs starts the mailbox import once a new connection is active.
type MailConnectionArgs struct {
	AccountID    string `json:"account_id"`
	TenantID     string `json:"tenant_id"`
	ConnectionID string `json:"connection_id"`
}

func (MailConnectionArgs) Kind() string { return "external.mail_connection" }
func (MailConnectionArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueExternal, MaxAttempts: 10, UniqueOpts: jobs.UniqueUnfinished}
}

type mailConnectionWorker struct {
	river.WorkerDefaults[MailConnectionArgs]
	service *Service
}

func (w *mailConnectionWorker) Work(ctx context.Context, job *river.Job[MailConnectionArgs]) error {
	a := job.Args
	connection, err := w.service.GetConnection(ctx, a.AccountID, a.ConnectionID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if connection.Status == "pending" {
		return river.JobSnooze(5 * time.Second)
	}
	if connection.Status != "active" {
		return nil
	}
	return w.service.EnsureMailImport(ctx, a.AccountID, a.TenantID, a.ConnectionID)
}

// MailImportArgs reads a Connection's mailbox snapshot, one page per run.
// The snapshot lives on the Connection: mail_import_status is running until
// the last page completes it or a terminal failure fails it, and its cursor,
// read count and provider calls advance with each page, so a restart resumes
// at the page in flight. The job snoozes between pages.
type MailImportArgs struct {
	ConnectionID string    `json:"connection_id"`
	Revision     int64     `json:"revision"`
	Start        time.Time `json:"mail_window_start"`
	End          time.Time `json:"mail_window_end"`
}

func (MailImportArgs) Kind() string { return "external.mail_import" }
func (MailImportArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueExternal, MaxAttempts: 25, UniqueOpts: jobs.UniqueUnfinished}
}

// mailImportBudget bounds the provider calls of one snapshot, retried pages
// included: message bodies, MIME body reads, pages, and identity.
const mailImportBudget = composio.MailImportMaxMessages*4 + 100

type mailImportWorker struct {
	river.WorkerDefaults[MailImportArgs]
	service *Service
}

func (w *mailImportWorker) Timeout(*river.Job[MailImportArgs]) time.Duration { return 10 * time.Minute }

// NextRetry backs off transient provider failures within a bounded delay.
func (w *mailImportWorker) NextRetry(job *river.Job[MailImportArgs]) time.Time {
	return time.Now().Add(mailImportRetryDelay(job.Attempt))
}

func mailImportRetryDelay(attempt int) time.Duration {
	delay := 5 * time.Second
	for i := 1; i < attempt && delay < 2*time.Minute; i++ {
		delay *= 2
	}
	return min(delay, 2*time.Minute)
}

func (w *mailImportWorker) Work(ctx context.Context, job *river.Job[MailImportArgs]) error {
	err := w.service.runMailImportPage(ctx, job.Args)
	var snooze *rivertype.JobSnoozeError
	if err == nil || errors.As(err, &snooze) || job.Attempt < job.MaxAttempts {
		return err
	}
	// River discards the job after this attempt, so the snapshot must not stay running.
	return errors.Join(err, w.service.failMailImport(context.WithoutCancel(ctx), job.Args.ConnectionID, job.Args.Revision, "provider_unavailable"))
}

// EnsureMailImport starts the mailbox snapshot of the Connection's current
// revision unless it already has one. The snapshot is shared by every Profile
// generation of that revision and published into the Personal Wiki of the
// Tenant that started it.
func (s *Service) EnsureMailImport(ctx context.Context, accountID, tenantID, connectionID string) error {
	connection, err := s.GetConnection(ctx, accountID, connectionID)
	if err != nil {
		return err
	}
	if !IsMailProvider(connection.Provider) {
		return ErrInvalid
	}
	if connection.Status != "active" {
		return ErrNotActive
	}
	if s.provider == nil {
		return ErrUnavailable
	}
	if _, err = s.ownerActorID(ctx, accountID, tenantID); err != nil {
		return err
	}
	end := time.Now().UTC().Truncate(time.Second)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE external_connections SET mail_import_status='running',mail_import_revision=revision,mail_import_tenant_id=$3,mail_import_error_code=NULL,
		mail_import_cursor='',mail_import_read=0,mail_import_provider_calls=0,mail_synced_until=NULL
		WHERE id=$1 AND account_id=$2 AND status='active' AND revision=$4 AND mail_import_revision IS DISTINCT FROM revision`,
		connectionID, accountID, tenantID, connection.Revision)
	if err != nil {
		return mapDatabaseError(err)
	}
	if tag.RowsAffected() == 1 {
		// The previous revision's snapshot is replaced.
		if _, err = tx.Exec(ctx, `DELETE FROM external_mail_import_documents WHERE connection_id=$1`, connectionID); err != nil {
			return err
		}
		if err = jobs.InsertTx(ctx, tx, MailImportArgs{ConnectionID: connectionID, Revision: connection.Revision, Start: composio.MailImportStart(end), End: end}, nil); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// failMailImport fails the running snapshot of revision.
func (s *Service) failMailImport(ctx context.Context, connectionID string, revision int64, code string) error {
	_, err := s.pool.Exec(ctx, `UPDATE external_connections SET mail_import_status='failed',mail_import_error_code=$3 WHERE id=$1 AND mail_import_revision=$2 AND mail_import_status='running'`, connectionID, revision, code)
	return err
}

// abandonMailImport drops the running snapshot of revision once its
// Connection is no longer active at that revision, so the next use while it
// is active starts it again instead of waiting for it.
func (s *Service) abandonMailImport(ctx context.Context, connectionID string, revision int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE external_connections SET mail_import_status=NULL,mail_import_revision=NULL,mail_import_tenant_id=NULL,mail_import_error_code=NULL,mail_import_cursor=NULL,mail_import_read=NULL,mail_import_provider_calls=NULL,mail_synced_until=NULL
		WHERE id=$1 AND mail_import_revision=$2 AND mail_import_status='running'`, connectionID, revision)
	return err
}

// reserveMailImportCall counts one provider call against the snapshot's
// budget on its Connection, so retried pages count too.
func (s *Service) reserveMailImportCall(ctx context.Context, job *importRun) error {
	var used int
	err := s.pool.QueryRow(ctx, `UPDATE external_connections SET mail_import_provider_calls=mail_import_provider_calls+1
		WHERE id=$1 AND status='active' AND revision=$2 AND mail_import_revision=$2 AND mail_import_status='running' AND mail_import_provider_calls<$3
		RETURNING mail_import_provider_calls`, job.ConnectionID, job.ConnectionRevision, mailImportBudget).Scan(&used)
	if err == nil {
		job.callsUsed.Store(int64(used))
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err = s.requireCurrentMailImport(ctx, job); err != nil {
		return err
	}
	return composio.ErrProviderCallBudgetExhausted
}

// requireCurrentMailImport fails a page whose snapshot ended or whose
// Connection is no longer the active revision it started on.
func (s *Service) requireCurrentMailImport(ctx context.Context, job *importRun) error {
	var current bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM external_connections WHERE id=$1 AND status='active' AND revision=$2 AND mail_import_revision=$2 AND mail_import_status='running')`, job.ConnectionID, job.ConnectionRevision).Scan(&current); err != nil {
		return err
	}
	if !current {
		return ErrStaleRevision
	}
	return nil
}

// runMailImportPage reads and publishes one page. A rate limit or an
// unfinished snapshot snoozes the River job. A snapshot whose Connection is no
// longer active at its revision is dropped; one that ended does nothing.
func (s *Service) runMailImportPage(ctx context.Context, args MailImportArgs) error {
	job := &importRun{ConnectionID: args.ConnectionID, ConnectionRevision: args.Revision, ProviderCallBudget: mailImportBudget, CreatedAt: time.Now().UTC(), mail: true}
	var progress mailImportProgress
	var active bool
	err := s.pool.QueryRow(ctx, `SELECT account_id,mail_import_tenant_id,provider,upstream_connection_id,mail_import_cursor,mail_import_read,status='active' AND revision=$2
		FROM external_connections WHERE id=$1 AND mail_import_revision=$2 AND mail_import_status='running'`, args.ConnectionID, args.Revision).Scan(
		&job.AccountID, &job.TenantID, &job.Provider, &job.UpstreamConnectionID, &progress.cursor, &progress.read, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !active {
		return s.abandonMailImport(ctx, args.ConnectionID, args.Revision)
	}
	if job.OwnerActorID, err = s.ownerActorID(ctx, job.AccountID, job.TenantID); errors.Is(err, ErrNotFound) {
		return s.failImport(ctx, job, "owner_not_found")
	} else if err != nil {
		return err
	}
	done, err := s.executeMailImport(ctx, job, args, progress)
	var retry importRetryError
	switch {
	case err == nil && done:
		return nil
	case err == nil:
		return river.JobSnooze(100 * time.Millisecond)
	case errors.Is(err, ErrStaleRevision):
		return s.abandonMailImport(context.WithoutCancel(ctx), args.ConnectionID, args.Revision)
	case errors.As(err, &retry):
		return river.JobSnooze(30 * time.Second)
	default:
		return err
	}
}

// mailImportProgress is how far a snapshot has read.
type mailImportProgress struct {
	cursor string
	read   int
}

// handleMailProviderError lets River retry transient provider failures with
// backoff; every other failure settles exactly like other App imports.
func (s *Service) handleMailProviderError(ctx context.Context, job *importRun, err error) error {
	if ctx.Err() != nil || !mailImportTransient(err) {
		return s.handleAppProviderError(ctx, job, err)
	}
	if job.Provider == "gmail" {
		s.logGmailProviderFailure(job, err)
	}
	return fmt.Errorf("mail import provider failure: %w", err)
}

// mailImportTransient reports provider failures worth a bounded River retry:
// 5xx, network, per-call deadline, and unknown errors.
func mailImportTransient(err error) bool {
	if errors.Is(err, ErrStaleRevision) || errors.Is(err, context.Canceled) || errors.Is(err, composio.ErrProviderCallBudgetExhausted) {
		return false
	}
	if _, terminal := importRetryPolicy(err); !terminal || composio.IsAuthFailure(err) {
		return false
	}
	var permanent interface{ ProviderTerminal() bool }
	return !errors.As(err, &permanent) || !permanent.ProviderTerminal()
}

// executeMailImport reads one page and reports whether it was the last.
func (s *Service) executeMailImport(ctx context.Context, job *importRun, args MailImportArgs, progress mailImportProgress) (bool, error) {
	provider := s.provider
	if provider == nil || !IsMailProvider(job.Provider) || args.Start.IsZero() || !args.Start.Before(args.End) || progress.read < 0 || progress.read >= composio.MailImportMaxMessages {
		return true, s.failImport(ctx, job, "invalid_request")
	}
	limit := min(100, composio.MailImportMaxMessages-progress.read)
	page, err := appProviderCall(ctx, s, job, provider, func(callCtx context.Context) (composio.MailImportPage, error) {
		return provider.FetchMailImportPage(callCtx, job.UpstreamConnectionID, job.Provider, composio.MailImportPageOptions{Start: args.Start, End: args.End, Cursor: progress.cursor, Limit: limit, BeforeProviderCall: func(ctx context.Context, _ string) error { return s.requireCurrentMailImport(ctx, job) }})
	})
	if err != nil {
		return true, s.handleMailProviderError(ctx, job, err)
	}
	if page.Skipped > 0 {
		s.logger.Warn("mail import skipped unreadable messages", "connection_id", job.ConnectionID, "provider", job.Provider, "skipped", page.Skipped)
	}
	if page.Read < 0 || page.Read > limit || len(page.Documents) > page.Read || page.NextCursor != "" && (page.NextCursor == progress.cursor || page.Read == 0) {
		return true, s.failImport(ctx, job, "invalid_provider_page")
	}
	// Provider pages may overlap when a mailbox changes during pagination.
	seen := make(map[string]bool)
	rows, err := s.pool.Query(ctx, `SELECT remote_id FROM external_mail_import_documents WHERE connection_id=$1`, job.ConnectionID)
	if err != nil {
		return false, err
	}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return false, err
		}
		seen[id] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, err
	}
	documents := page.Documents[:0]
	for _, document := range page.Documents {
		if document.RemoteID == "" {
			return true, s.failImport(ctx, job, "invalid_provider_page")
		}
		if !seen[document.RemoteID] {
			documents = append(documents, document)
			seen[document.RemoteID] = true
		}
	}
	if err = s.publishMailPage(ctx, job, documents); err != nil {
		return false, err
	}
	read := progress.read + page.Read
	done := page.NextCursor == "" || read == composio.MailImportMaxMessages
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var locked bool
	err = tx.QueryRow(ctx, `SELECT mail_import_read=$3 FROM external_connections WHERE id=$1 AND status='active' AND revision=$2 AND mail_import_revision=$2 AND mail_import_status='running' FOR UPDATE`, job.ConnectionID, job.ConnectionRevision, progress.read).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrStaleRevision
	}
	if err == nil && !locked {
		// Another run of this job already stored the page.
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for i, document := range documents {
		raw, err := json.Marshal(document)
		if err != nil {
			return false, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO external_mail_import_documents(connection_id,remote_id,ordinal,document) VALUES($1,$2,$3,$4) ON CONFLICT(connection_id,remote_id) DO NOTHING`, job.ConnectionID, document.RemoteID, progress.read+i, raw); err != nil {
			return false, err
		}
	}
	status := "running"
	if done {
		status = "completed"
	}
	// The nightly sync reads on from the end of a completed snapshot.
	if _, err = tx.Exec(ctx, `UPDATE external_connections SET mail_import_cursor=$2,mail_import_read=$3,mail_import_status=$4,
		mail_synced_until=CASE WHEN $4='completed' THEN $5::timestamptz END WHERE id=$1`, job.ConnectionID, page.NextCursor, read, status, args.End); err != nil {
		return false, err
	}
	if done && s.mailImported != nil {
		if err = s.mailImported(ctx, tx, MailImported{TenantID: job.TenantID, OwnerActorID: job.OwnerActorID, ConnectionID: job.ConnectionID, Revision: job.ConnectionRevision}); err != nil {
			return false, err
		}
	}
	return done, tx.Commit(ctx)
}

// publishMailPage writes a page's admitted messages as Wiki sources. It is
// idempotent per message, so a retried page publishes nothing new.
func (s *Service) publishMailPage(ctx context.Context, job *importRun, documents []composio.AppDocument) error {
	if s.writeMailWikiSource != nil {
		for _, document := range documents {
			if len(document.Markdown) == 0 {
				continue
			}
			if err := s.writeMailWikiSource(ctx, MailWikiSource{
				TenantID: job.TenantID, OwnerActorID: job.OwnerActorID,
				SourceKey: "mail:" + job.ConnectionID + ":" + document.RemoteID,
				Filename:  mailWikiFilename(document.Filename), Content: document.Markdown,
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

func mailWikiFilename(name string) string {
	name = strings.NewReplacer("/", "-", "\\", "-", "\x00", "").Replace(strings.TrimSpace(name))
	if name == "" {
		name = "email.md"
	}
	if len(name) > 255 {
		name = name[len(name)-255:]
	}
	return name
}

// ReadMailImport returns the Connection's mailbox snapshot, starting it when
// its current revision has none. While the snapshot is still being read the
// status is running. It returns at most 16 MiB of evidence; Profile and Insight
// apply their smaller input budgets.
func (s *Service) ReadMailImport(ctx context.Context, accountID, tenantID, connectionID string) (TransientImportResult, error) {
	if _, err := s.loadAuthorizedConnection(ctx, accountID, tenantID, connectionID); err != nil {
		return TransientImportResult{}, err
	}
	if err := s.EnsureMailImport(ctx, accountID, tenantID, connectionID); err != nil {
		return TransientImportResult{}, err
	}
	var status, code string
	err := s.pool.QueryRow(ctx, `SELECT CASE WHEN mail_import_revision=revision THEN coalesce(mail_import_status,'running') ELSE 'running' END,coalesce(mail_import_error_code,'') FROM external_connections WHERE id=$1 AND account_id=$2`, connectionID, accountID).Scan(&status, &code)
	if errors.Is(err, pgx.ErrNoRows) {
		return TransientImportResult{}, ErrNotFound
	}
	if err != nil {
		return TransientImportResult{}, err
	}
	result := TransientImportResult{Status: status, LastErrorCode: code}
	if status != "completed" {
		return result, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT document FROM external_mail_import_documents WHERE connection_id=$1 ORDER BY ordinal,remote_id`, connectionID)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	var evidenceBytes int
	for rows.Next() {
		var raw []byte
		var document composio.AppDocument
		if err = rows.Scan(&raw); err != nil {
			return result, err
		}
		if evidenceBytes+len(raw) > 16<<20 {
			result.Truncated = true
			break
		}
		evidenceBytes += len(raw)
		if err = json.Unmarshal(raw, &document); err != nil {
			return result, err
		}
		result.Documents = append(result.Documents, document)
	}
	result.Fetched = len(result.Documents)
	return result, rows.Err()
}
