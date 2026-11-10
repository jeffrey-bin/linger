package personalprofile

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/emailevidence"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

// importWaitExpired reports whether a generation has waited past its deadline
// for source imports, measured from when its first attempt started.
func importWaitExpired(startedAt, now time.Time) bool {
	return !startedAt.IsZero() && !now.Before(startedAt.Add(ImportWaitDeadline))
}

const (
	generationKind = "personal_profile.generation"
	// generationTimeout bounds one attempt. Import waits snooze instead of
	// holding an attempt, so an attempt spends its time on LLM and file work.
	generationTimeout = 10 * time.Minute
)

// GenerationArgs asks for one Personal Profile generation to run.
type GenerationArgs struct {
	GenerationID string `json:"generation_id"`
}

func (GenerationArgs) Kind() string { return generationKind }

func (GenerationArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue: jobs.QueueGeneration,
		// The cap counts failed runs; the attempt after the cap settles the row.
		MaxAttempts: MaxGenerationAttempts + 1,
		UniqueOpts:  jobs.UniqueUnfinished,
	}
}

// AddJobWorkers registers the Personal Profile generation worker.
func AddJobWorkers(workers *river.Workers, service *Service) {
	river.AddWorker(workers, &generationWorker{service: service})
}

type generationWorker struct {
	river.WorkerDefaults[GenerationArgs]
	service *Service
}

func (w *generationWorker) Timeout(*river.Job[GenerationArgs]) time.Duration {
	return generationTimeout
}

func (w *generationWorker) Work(ctx context.Context, job *river.Job[GenerationArgs]) error {
	return w.service.runGeneration(ctx, job.Args.GenerationID, job.Attempt)
}

// runGeneration runs one attempt. Waits and rebases snooze, which does not
// spend an attempt. Content failures settle the row and return nil; errors
// from the database are returned so River retries the attempt.
func (s *Service) runGeneration(ctx context.Context, generationID string, attempt int) error {
	claimed, ok, err := s.claim(ctx, generationID, attempt)
	if err != nil || !ok {
		return err
	}
	return s.executeClaimedSources(ctx, claimed, claimed.sources)
}

// attemptsExhausted reports whether this attempt is past the cap of failed
// runs. Only the cap's last attempt reaches here, so a crash on it cannot leave
// the row running with no attempt left to settle it.
func attemptsExhausted(attempt int) bool {
	return attempt > MaxGenerationAttempts
}

// claim moves a queued or running generation to running and loads its stored
// sources and baseline. A row that is no longer open is finished, so ok is false.
func (s *Service) claim(ctx context.Context, generationID string, attempt int) (claimedGeneration, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return claimedGeneration{}, false, err
	}
	defer tx.Rollback(ctx)
	var claimed claimedGeneration
	var baseRevisionID *string
	err = tx.QueryRow(ctx, `
		SELECT generation.id,generation.tenant_id,generation.owner_actor_id,generation.base_profile_revision_id,actor.account_id,actor.display_name,
		       coalesce(generation.started_at,now()),now()
		FROM personal_profile_generations generation
		JOIN actors actor ON actor.id=generation.owner_actor_id AND actor.tenant_id=generation.tenant_id
		WHERE generation.id=$1 AND generation.status IN ('queued','running')
		FOR UPDATE OF generation`, generationID).Scan(&claimed.ID, &claimed.TenantID, &claimed.ActorID, &baseRevisionID, &claimed.AccountID, &claimed.SubjectDisplayName, &claimed.StartedAt, &claimed.ClaimedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return claimedGeneration{}, false, nil
	}
	if err != nil {
		return claimedGeneration{}, false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE personal_profile_generations SET status='running',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1`, claimed.ID); err != nil {
		return claimedGeneration{}, false, err
	}
	if attemptsExhausted(attempt) {
		return claimedGeneration{}, false, s.failGeneration(ctx, tx, claimed.ID, "PROFILE_GENERATION_ATTEMPTS_EXHAUSTED", nil)
	}
	sources, err := s.loadStoredSources(ctx, tx, generationID)
	if err != nil {
		return claimedGeneration{}, false, err
	}
	claimed.sources = sources
	if baseRevisionID != nil {
		claimed.BaseRevisionID = *baseRevisionID
		var baseline Document
		if err = tx.QueryRow(ctx, `SELECT profile FROM personal_profile_revisions WHERE id=$1 AND tenant_id=$2 AND owner_actor_id=$3`, *baseRevisionID, claimed.TenantID, claimed.ActorID).Scan(&baseline); err != nil {
			return claimedGeneration{}, false, s.failGeneration(ctx, tx, claimed.ID, "BASE_PROFILE_MISSING", nil)
		}
		claimed.BaselineProfile = string(CanonicalJSON(baseline))
	}
	if err = tx.Commit(ctx); err != nil {
		return claimedGeneration{}, false, err
	}
	return claimed, true, nil
}

type claimedGeneration struct {
	SubjectDisplayName               string
	ID, TenantID, ActorID, AccountID string
	BaseRevisionID                   string
	// BaselineProfile is the base Document's canonical JSON for the model and
	// publication comparison.
	BaselineProfile      string
	StartedAt, ClaimedAt time.Time
	sources              []storedSource
}

type storedSource struct {
	Ordinal                                                      int
	Kind, InputVersionID, Filename, MediaType, ObjectKey, SHA256 string
	ConnectionID, Provider, ExternalAISummary                    string
	Selections                                                   []Selection
}

func (s *Service) loadStoredSources(ctx context.Context, tx pgx.Tx, generationID string) ([]storedSource, error) {
	rows, err := tx.Query(ctx, `
		SELECT (source.ordinality-1)::int, source.value->>'kind', coalesce(source.value->>'input_version_id',''), coalesce(document_version.filename, ''),
		       coalesce(document_version.media_type, ''), coalesce(document_version.content_object_id, ''), coalesce(source.value->>'file_sha256',''),
		       coalesce(source.value->>'connection_id',''), coalesce(source.value->>'provider',''), coalesce(source.value->>'external_ai_summary',''),
		       coalesce(source.value->'selections','[]'::jsonb)
		FROM personal_profile_generations generation
		CROSS JOIN LATERAL jsonb_array_elements(generation.sources) WITH ORDINALITY AS source(value,ordinality)
		LEFT JOIN document_versions document_version ON document_version.id=source.value->>'input_version_id'
		WHERE generation.id=$1
		ORDER BY source.ordinality`, generationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var sources []storedSource
	for rows.Next() {
		var item storedSource
		var raw []byte
		if err = rows.Scan(&item.Ordinal, &item.Kind, &item.InputVersionID, &item.Filename, &item.MediaType, &item.ObjectKey, &item.SHA256, &item.ConnectionID, &item.Provider, &item.ExternalAISummary, &raw); err != nil {
			return nil, err
		}
		item.Selections, err = decodeSelections(raw)
		if err != nil {
			return nil, err
		}
		sources = append(sources, item)
	}
	return sources, rows.Err()
}

func (s *Service) executeClaimedSources(ctx context.Context, claimed claimedGeneration, sources []storedSource) error {
	collected, retry, authFailed, err := s.collectGenerationDocuments(ctx, claimed, sources)
	var setup importSetupError
	if errors.As(err, &setup) {
		return s.finishFailed(ctx, claimed.ID, importErrorCode(setup.err))
	}
	if err != nil {
		return s.finishFailed(ctx, claimed.ID, "SOURCE_UNAVAILABLE")
	}
	if retry {
		if importWaitExpired(claimed.StartedAt, claimed.ClaimedAt) {
			return s.finishFailed(ctx, claimed.ID, "PROFILE_IMPORT_TIMEOUT")
		}
		return s.deferGeneration(ctx, claimed.ID, "IMPORT_RETRY_WAIT")
	}
	if !hasMeaningfulProfileEvidence(collected.profile) {
		return s.finishFailed(ctx, claimed.ID, emptyImportFailureCode(authFailed))
	}
	if s.generator == nil {
		return s.finishFailed(ctx, claimed.ID, "PROFILE_GENERATOR_UNAVAILABLE")
	}
	result, genErr := s.generator.Generate(ctx, GenerationRequest{
		TenantID: claimed.TenantID, OwnerActorID: claimed.ActorID, SubjectDisplayName: claimed.SubjectDisplayName,
		PromptVersion: PromptVersion, BaselineProfile: claimed.BaselineProfile, Documents: collected.profile,
	})
	if errors.Is(genErr, roomagent.ErrModelCallComputerOffline) {
		if jobs.ComputerOfflineWaitExpired(claimed.StartedAt, claimed.ClaimedAt) {
			return s.finishFailed(ctx, claimed.ID, "COMPUTER_OFFLINE_TIMEOUT")
		}
		return s.deferGenerationFor(ctx, claimed.ID, "COMPUTER_OFFLINE_WAIT", jobs.ComputerOfflineRetryDelay)
	}
	// The call runs on in the Agent Service; the next attempt joins it or
	// receives its result.
	if errors.Is(genErr, roomagent.ErrModelCallPending) {
		if jobs.ComputerOfflineWaitExpired(claimed.StartedAt, claimed.ClaimedAt) {
			return s.finishFailed(ctx, claimed.ID, "MODEL_CALL_PENDING_TIMEOUT")
		}
		return s.deferGenerationFor(ctx, claimed.ID, "MODEL_CALL_PENDING_WAIT", jobs.ComputerOfflineRetryDelay)
	}
	if genErr != nil {
		// The stored code hides the cause; gateway errors carry only a status, never profile content.
		slog.Default().Warn("Personal Profile generator unavailable",
			"generation_id", claimed.ID, "tenant_id", claimed.TenantID, "error", genErr)
		return s.finishFailed(ctx, claimed.ID, "PROFILE_GENERATOR_UNAVAILABLE")
	}
	if result.Error != "" {
		return s.finishFailed(ctx, claimed.ID, result.Error)
	}
	// Every Generator implementation must return a publishable document.
	if result.Profile, genErr = NormalizeDocument(result.Profile); genErr != nil {
		return s.finishFailed(ctx, claimed.ID, "INVALID_PROFILE_OUTPUT")
	}
	return s.finishSucceeded(ctx, claimed, result, collected.insight)
}

// Only admitted, nonempty content can support a Profile revision.
func hasMeaningfulProfileEvidence(documents []GenerationDocument) bool {
	for _, document := range documents {
		if strings.TrimSpace(document.Content) != "" {
			return true
		}
	}
	return false
}

// collectedDocuments are one attempt's inputs: the Profile model reads
// profile, and the Personal Insight step that follows reads insight.
type collectedDocuments struct {
	profile []GenerationDocument
	insight []InsightDocument
}

func (s *Service) collectGenerationDocuments(ctx context.Context, claimed claimedGeneration, sources []storedSource) (collectedDocuments, bool, bool, error) {
	var collected collectedDocuments
	var total int64
	var insightTotal int64
	var authFailed bool
	for _, source := range sources {
		if source.Kind == "external_ai_summary" {
			content := strings.TrimSpace(source.ExternalAISummary)
			if content == "" {
				return collectedDocuments{}, false, false, errors.New("external AI summary missing")
			}
			allowed, err := s.transientAdmission(ctx, []composio.AppDocument{{Filename: "external-ai-summary.md", Markdown: []byte(content)}})
			if err != nil {
				return collectedDocuments{}, false, false, err
			}
			if !allowed[0] {
				continue
			}
			collected.profile = append(collected.profile, GenerationDocument{Provider: "external_ai_summary", Filename: "external-ai-summary.md", Content: content})
			total += int64(len(content))
			continue
		}
		if source.Kind == "input_version" {
			ok, wait, err := s.fileAdmission(ctx, claimed.TenantID, source.InputVersionID)
			if err != nil || wait {
				return collectedDocuments{}, wait, false, err
			}
			if !ok {
				continue
			}
			if source.ObjectKey == "" {
				return collectedDocuments{}, false, false, errors.New("profile file missing")
			}
			reader, openErr := s.objects.Open(ctx, source.ObjectKey)
			if openErr != nil {
				return collectedDocuments{}, false, false, openErr
			}
			body, readErr := io.ReadAll(io.LimitReader(reader, MaxFileBytes+1))
			closeErr := reader.Close()
			if readErr != nil {
				return collectedDocuments{}, false, false, readErr
			}
			if closeErr != nil {
				return collectedDocuments{}, false, false, closeErr
			}
			text, extractErr := SniffAndExtract(source.Filename, source.MediaType, body)
			if extractErr != nil || text == "" {
				return collectedDocuments{}, false, false, errors.New("profile file unreadable")
			}
			collected.profile = append(collected.profile, GenerationDocument{Provider: source.Kind, Filename: source.Filename, Content: text})
			continue
		}
		if source.Kind != "connection" {
			return collectedDocuments{}, false, false, importSetupError{ErrInvalid}
		}
		result, importErr := s.importConnection(ctx, claimed.AccountID, claimed.TenantID, source)
		if importErr != nil {
			return collectedDocuments{}, false, false, importSetupError{importErr}
		}
		if result.Status == "retry_wait" || result.Status == "queued" || result.Status == "running" {
			return collectedDocuments{}, true, false, nil
		}
		if result.Status != "completed" && result.Status != "partial" {
			if result.LastErrorCode == "provider_auth_failed" {
				authFailed = true
			}
			continue
		}
		allowed, wait, err := s.connectionAdmission(ctx, claimed, source, result.Documents)
		if err != nil || wait {
			return collectedDocuments{}, wait, false, err
		}
		for _, document := range result.Documents {
			if externalsource.IsMailProvider(source.Provider) && len(document.InsightEvidence) > 0 {
				bounded, boundErr := emailevidence.BoundMessageInputsJSON(document.InsightEvidence, int(s.options.MaxDocument))
				if boundErr == nil && len(collected.insight) < s.options.MaxDocuments && insightTotal+int64(len(bounded)) <= s.options.MaxInsightInput {
					collected.insight = append(collected.insight, InsightDocument{Provider: source.Provider, Filename: "insight/" + document.Filename, Content: string(bounded)})
					insightTotal += int64(len(bounded))
				}
			}
		}
		// Mail people wrote takes the budget before automated mail.
		for _, automated := range []bool{false, true} {
			for i, document := range result.Documents {
				if document.Automated != automated || !allowed[i] {
					continue
				}
				content := string(document.Markdown)
				if externalsource.IsMailProvider(source.Provider) {
					// The whole message, marked by author and kind.
					content = string(document.ProfileMarkdown)
				}
				if content == "" {
					continue
				}
				cost := int64(len(content))
				if total+cost > s.options.MaxInput {
					continue
				}
				total += cost
				label := source.Provider
				if label == "" {
					label = source.Kind
				}
				collected.profile = append(collected.profile, GenerationDocument{Provider: label, Filename: label + "/" + document.Filename, Content: content})
			}
		}
	}
	return collected, false, authFailed, nil
}

// importSetupError is a connection source that could not start: the
// Connection is missing or not active, or the selection is invalid.
type importSetupError struct{ err error }

func (e importSetupError) Error() string { return "connection import setup: " + e.err.Error() }

func emptyImportFailureCode(authFailed bool) string {
	if authFailed {
		return "PROVIDER_AUTH_FAILED"
	}
	return "NO_IMPORT_CONTENT"
}

// deferGeneration queues the generation again and snoozes its job until the
// retry is due. The snooze does not spend an attempt.
func (s *Service) deferGeneration(ctx context.Context, generationID, code string) error {
	return s.deferGenerationFor(ctx, generationID, code, s.options.RetryDelay)
}

func (s *Service) deferGenerationFor(ctx context.Context, generationID, code string, delay time.Duration) error {
	_, err := s.pool.Exec(ctx, `UPDATE personal_profile_generations SET status='queued',last_error_code=$2,updated_at=now() WHERE id=$1 AND status='running'`, generationID, code)
	if err != nil {
		return err
	}
	return river.JobSnooze(delay)
}

func importErrorCode(err error) string {
	switch {
	case errors.Is(err, externalsource.ErrUnavailable):
		return "IMPORT_PROVIDER_UNAVAILABLE"
	case errors.Is(err, externalsource.ErrNotActive):
		return "CONNECTION_NOT_ACTIVE"
	case errors.Is(err, externalsource.ErrInvalid):
		return "INVALID_IMPORT_SELECTION"
	case errors.Is(err, ErrUnsupportedSource):
		return "PROFILE_SOURCE_UNSUPPORTED"
	default:
		return "IMPORT_SETUP_FAILED"
	}
}

func (s *Service) finishSucceeded(ctx context.Context, claimed claimedGeneration, result GenerationResult, insight []InsightDocument) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `
		SELECT pg_advisory_xact_lock(hashtextextended('personal-wiki|' || id,0))
		FROM personal_wikis
		WHERE tenant_id=$1 AND owner_actor_id=$2 AND deleted_at IS NULL`, claimed.TenantID, claimed.ActorID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE personal_profile_generations SET status='succeeded',completed_at=now(),updated_at=now(),last_error_code=NULL WHERE id=$1 AND status='running'`, claimed.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	// Serialize publication for one Human, then compare the baseline accepted
	// for this inference. A competing source must be merged on retry.
	currentID, err := lockCurrentRevision(ctx, tx, claimed.TenantID, claimed.ActorID)
	if err != nil {
		return err
	}
	if currentID != claimed.BaseRevisionID {
		if err = tx.Rollback(ctx); err != nil {
			return err
		}
		return s.rebaseGeneration(ctx, claimed)
	}
	revisionID := currentID
	if currentID == "" || string(CanonicalJSON(result.Profile)) != claimed.BaselineProfile {
		var published bool
		revisionID, published, err = publishRevision(ctx, tx, claimed.TenantID, claimed.ActorID, claimed.BaseRevisionID, result.Profile, claimed.ID, nil)
		if err != nil {
			return err
		}
		if !published {
			if err = tx.Rollback(ctx); err != nil {
				return err
			}
			return s.rebaseGeneration(ctx, claimed)
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE personal_profile_generations SET decision_status='confirmed',candidate_revision_id=$2,updated_at=now() WHERE id=$1`, claimed.ID, revisionID); err != nil {
		return err
	}
	if err = account.ApplyGenerated(ctx, tx, claimed.TenantID, claimed.ActorID, result.Account); err != nil {
		return err
	}
	if err = s.options.EnqueuePersonalInsight(ctx, tx, claimed.ID, insight); err != nil {
		return err
	}
	if err = clearTerminalExternalAISummaries(ctx, tx, claimed.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) finishFailed(ctx context.Context, generationID, code string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	return s.failGeneration(ctx, tx, generationID, code, nil)
}

func (s *Service) failGeneration(ctx context.Context, tx pgx.Tx, generationID, code string, cause error) error {
	if _, err := tx.Exec(ctx, `UPDATE personal_profile_generations SET status='failed',last_error_code=$2,completed_at=now(),updated_at=now() WHERE id=$1 AND status='running'`, generationID, code); err != nil {
		return errors.Join(cause, err)
	}
	if err := clearTerminalExternalAISummaries(ctx, tx, generationID); err != nil {
		return errors.Join(cause, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.Join(cause, err)
	}
	return cause
}

// Rebase only the derived baseline; the selected import jobs and input versions
// remain the same. A competing accepted update must never be overwritten.
func (s *Service) rebaseGeneration(ctx context.Context, claimed claimedGeneration) error {
	_, err := s.pool.Exec(ctx, `UPDATE personal_profile_generations generation
	SET base_profile_revision_id=(SELECT revision_id FROM personal_profile_currents WHERE tenant_id=generation.tenant_id AND owner_actor_id=generation.owner_actor_id),
	status='queued',last_error_code='PROFILE_BASE_CHANGED',updated_at=now()
	WHERE id=$1 AND status='running'`, claimed.ID)
	if err != nil {
		return err
	}
	return river.JobSnooze(time.Second)
}
