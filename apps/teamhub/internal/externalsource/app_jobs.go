package externalsource

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

type DiscordImportRequest struct {
	ChannelIDs            []string `json:"channel_ids"`
	Days                  int      `json:"days"`
	MaxMessagesPerChannel int      `json:"max_messages_per_channel"`
	IncludeThreads        bool     `json:"include_threads"`
}

type GitHubRepositorySelection struct {
	RepositoryID string `json:"repository_id"`
	FullName     string `json:"full_name"`
}

type GitHubImportRequest struct {
	Repositories []GitHubRepositorySelection `json:"repositories"`
}

type GoogleCalendarImportRequest struct {
	CalendarIDs          []string `json:"calendar_ids"`
	Days                 int      `json:"days"`
	MaxEventsPerCalendar int      `json:"max_events_per_calendar"`
}

type NotionResourceSelection struct {
	ResourceID string `json:"resource_id"`
	Title      string `json:"title"`
	Kind       string `json:"kind"`
}

type NotionImportRequest struct {
	Resources []NotionResourceSelection `json:"resources"`
}

// ImportDiscord fetches the selected Discord channels for its caller.
func (s *Service) ImportDiscord(ctx context.Context, accountID, tenantID, connectionID string, request DiscordImportRequest, budget int) (TransientImportResult, error) {
	if s.provider == nil || len(request.ChannelIDs) == 0 || len(request.ChannelIDs) > 20 || request.Days < 1 || request.Days > 30 || request.MaxMessagesPerChannel < 1 || request.MaxMessagesPerChannel > 5000 || budget < 5 {
		return TransientImportResult{}, ErrInvalid
	}
	if !uniqueNonempty(request.ChannelIDs) {
		return TransientImportResult{}, ErrInvalid
	}
	return s.runImport(ctx, accountID, tenantID, connectionID, "discord", request, budget)
}

// ImportGitHub fetches the selected GitHub repositories for its caller.
func (s *Service) ImportGitHub(ctx context.Context, accountID, tenantID, connectionID string, request GitHubImportRequest, budget int) (TransientImportResult, error) {
	if s.provider == nil || len(request.Repositories) > 5 || budget < 2+len(request.Repositories) {
		return TransientImportResult{}, ErrInvalid
	}
	seen := map[string]bool{}
	for _, selection := range request.Repositories {
		if selection.RepositoryID == "" || selection.FullName == "" || seen[selection.RepositoryID] {
			return TransientImportResult{}, ErrInvalid
		}
		seen[selection.RepositoryID] = true
	}
	return s.runImport(ctx, accountID, tenantID, connectionID, "github", request, budget)
}

func (s *Service) ListGitHubRepositories(ctx context.Context, accountID, connectionID, cursor string, limit int) (composio.GitHubRepositoryPage, error) {
	if s.provider == nil || limit < 1 || limit > 100 {
		return composio.GitHubRepositoryPage{}, ErrInvalid
	}
	connection, err := s.loadProviderConnection(ctx, accountID, connectionID, "github")
	if err != nil {
		return composio.GitHubRepositoryPage{}, err
	}
	if connection.Status != "active" {
		return composio.GitHubRepositoryPage{}, ErrNotActive
	}
	identity, err := s.provider.IdentifyGitHub(ctx, connection.UpstreamConnectionID)
	if err != nil {
		return composio.GitHubRepositoryPage{}, errors.Join(ErrUnavailable, err)
	}
	if connection.RemotePrincipalKey != "github:"+identity.UserID {
		return composio.GitHubRepositoryPage{}, ErrStaleRevision
	}
	page, err := s.provider.ListGitHubRepositories(ctx, connection.UpstreamConnectionID, identity, cursor, limit)
	if err != nil {
		return composio.GitHubRepositoryPage{}, errors.Join(ErrUnavailable, err)
	}
	current, err := s.loadConnection(ctx, accountID, connectionID)
	if err != nil || current.Status != "active" || current.Revision != connection.Revision {
		return composio.GitHubRepositoryPage{}, ErrStaleRevision
	}
	return page, nil
}

// ImportNotion fetches the selected Notion pages and databases for its caller.
func (s *Service) ImportNotion(ctx context.Context, accountID, tenantID, connectionID string, request NotionImportRequest, budget int) (TransientImportResult, error) {
	if s.provider == nil || len(request.Resources) < 1 || len(request.Resources) > 10 || budget < 3+len(request.Resources)*2 {
		return TransientImportResult{}, ErrInvalid
	}
	seen := map[string]bool{}
	for _, selection := range request.Resources {
		if selection.ResourceID == "" || selection.Title == "" || selection.Kind != "notion_page" && selection.Kind != "notion_database" || seen[selection.ResourceID] {
			return TransientImportResult{}, ErrInvalid
		}
		seen[selection.ResourceID] = true
	}
	return s.runImport(ctx, accountID, tenantID, connectionID, "notion", request, budget)
}

func (s *Service) ListNotionResources(ctx context.Context, accountID, connectionID, cursor string, limit int) (composio.NotionResourcePage, error) {
	if s.provider == nil || limit < 1 || limit > 100 {
		return composio.NotionResourcePage{}, ErrInvalid
	}
	connection, err := s.loadProviderConnection(ctx, accountID, connectionID, "notion")
	if err != nil {
		return composio.NotionResourcePage{}, err
	}
	if connection.Status != "active" {
		return composio.NotionResourcePage{}, ErrNotActive
	}
	identity, err := s.provider.IdentifyNotion(ctx, connection.UpstreamConnectionID)
	if err != nil {
		return composio.NotionResourcePage{}, errors.Join(ErrUnavailable, err)
	}
	if connection.RemotePrincipalKey != "notion:"+identity.BotID {
		return composio.NotionResourcePage{}, ErrStaleRevision
	}
	page, err := s.provider.ListNotionResources(ctx, connection.UpstreamConnectionID, cursor, limit)
	if err != nil {
		return composio.NotionResourcePage{}, errors.Join(ErrUnavailable, err)
	}
	current, err := s.loadConnection(ctx, accountID, connectionID)
	if err != nil || current.Status != "active" || current.Revision != connection.Revision {
		return composio.NotionResourcePage{}, ErrStaleRevision
	}
	return page, nil
}

// ImportGoogleCalendar fetches the selected Google Calendar events for its caller.
func (s *Service) ImportGoogleCalendar(ctx context.Context, accountID, tenantID, connectionID string, request GoogleCalendarImportRequest, budget int) (TransientImportResult, error) {
	if s.provider == nil || len(request.CalendarIDs) == 0 || len(request.CalendarIDs) > 10 || request.Days < 1 || request.Days > 365 || request.MaxEventsPerCalendar < 1 || request.MaxEventsPerCalendar > 1000 || budget < 3 {
		return TransientImportResult{}, ErrInvalid
	}
	if !uniqueNonempty(request.CalendarIDs) {
		return TransientImportResult{}, ErrInvalid
	}
	return s.runImport(ctx, accountID, tenantID, connectionID, "google_calendar", request, budget)
}

func uniqueNonempty(values []string) bool {
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			return false
		}
		seen[value] = true
	}
	return true
}

func statusForImportProvider(ctx context.Context, remote Provider, upstreamID, provider string) (composio.ConnectionStatus, error) {
	toolkit := map[string]string{"discord": "discordbot", "github": "github", "google_calendar": "googlecalendar", "notion": "notion", "outlook": "outlook"}[provider]
	return remote.GetConnectionStatusForToolkit(ctx, upstreamID, toolkit)
}

func appProviderCall[T any](ctx context.Context, s *Service, job *importRun, provider any, call func(context.Context) (T, error)) (T, error) {
	var zero T
	reserve := func(reservationCtx context.Context) error {
		return s.reserveImportProviderAttempt(reservationCtx, job)
	}
	callCtx := composio.WithProviderAttemptReservation(ctx, reserve)
	if durable, ok := provider.(interface{ UsesProviderAttemptReservation() bool }); !ok || !durable.UsesProviderAttemptReservation() {
		if err := reserve(ctx); err != nil {
			return zero, err
		}
	}
	return call(callCtx)
}

// reserveImportProviderAttempt counts one provider call against the run's
// budget while its Connection is still the revision it started on. A
// synchronous import counts in memory; its caller's next attempt starts with
// a fresh budget.
func (s *Service) reserveImportProviderAttempt(ctx context.Context, job *importRun) error {
	if job.mail {
		return s.reserveMailImportCall(ctx, job)
	}
	if err := s.requireCurrentImport(ctx, job); err != nil {
		return err
	}
	if job.callsUsed.Add(1) > int64(job.ProviderCallBudget) {
		return composio.ErrProviderCallBudgetExhausted
	}
	return nil
}

func (s *Service) handleAppProviderError(ctx context.Context, job *importRun, err error) error {
	if job.Provider == "gmail" {
		s.logGmailProviderFailure(job, err)
	}
	if errors.Is(err, ErrStaleRevision) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if errors.Is(err, composio.ErrProviderCallBudgetExhausted) {
		return s.failImport(ctx, job, "provider_call_budget_exhausted")
	}
	return s.retryImport(ctx, job, err)
}

func (s *Service) logGmailProviderFailure(job *importRun, cause error) {
	statusCode, _ := composio.ErrorStatus(cause)
	// Gmail jobs are mail imports: rate limits snooze and transient failures retry.
	_, terminal := importRetryPolicy(cause)
	retryable := !terminal || mailImportTransient(cause)

	s.logger.Error("gmail provider call failed",
		"connection_id", job.ConnectionID,
		"provider", "gmail",
		"operation", "mail_import_page",
		"provider_calls_used", job.callsUsed.Load(),
		"provider_call_budget", job.ProviderCallBudget,
		"http_status", statusCode,
		"error_class", gmailProviderErrorClass(cause, statusCode),
		"retryable", retryable,
		"error", cause,
	)
}

func gmailProviderErrorClass(cause error, statusCode int) string {
	if errors.Is(cause, composio.ErrProviderCallBudgetExhausted) {
		return "provider_call_budget_exhausted"
	}
	if errors.Is(cause, context.DeadlineExceeded) {
		return "provider_timeout"
	}
	if errors.Is(cause, context.Canceled) {
		return "provider_cancelled"
	}
	var limited *composio.RateLimitError
	if errors.As(cause, &limited) || statusCode == 429 {
		return "provider_rate_limited"
	}
	if composio.IsAuthFailure(cause) {
		return "provider_auth_failed"
	}
	if statusCode >= 500 {
		return "provider_5xx"
	}
	if statusCode >= 400 {
		return "provider_http_error"
	}
	return "provider_unavailable"
}

func (s *Service) executeDiscordJob(ctx context.Context, job *importRun) error {
	var request DiscordImportRequest
	if err := json.Unmarshal(job.Request, &request); err != nil {
		return s.failImport(ctx, job, "invalid_request")
	}
	remaining := job.ProviderCallBudget
	if remaining < 5 || s.provider == nil {
		return s.failImport(ctx, job, "provider_call_budget_exhausted")
	}
	if err := s.requireCurrentImport(ctx, job); err != nil {
		return err
	}
	contentBudget := composio.NewAppImportAccumulator(s.appImportLimits)
	var persistedGuildID string
	if err := s.pool.QueryRow(ctx, `SELECT coalesce(remote_team_id,'') FROM external_connections WHERE id=$1 AND account_id=$2 AND provider='discord' AND status='active' AND revision=$3`, job.ConnectionID, job.AccountID, job.ConnectionRevision).Scan(&persistedGuildID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrStaleRevision
		}
		return err
	}
	if validateDiscordGuildID(persistedGuildID) != nil {
		return ErrStaleRevision
	}
	identity, err := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.DiscordIdentity, error) {
		return s.provider.GetDiscordGuild(callCtx, job.UpstreamConnectionID, persistedGuildID)
	})
	if err != nil {
		return s.handleAppProviderError(ctx, job, err)
	}
	if err := contentBudget.AddRecord(identity.GuildID, identity.GuildName); err != nil {
		return s.failImport(ctx, job, "content_too_large")
	}
	if identity.GuildID != persistedGuildID {
		return ErrStaleRevision
	}
	if ok, matchErr := s.importIdentityMatches(ctx, job, "discord:guild:"+persistedGuildID); matchErr != nil || !ok {
		return ErrStaleRevision
	}
	if err := s.requireCurrentImport(ctx, job); err != nil {
		return err
	}
	availableChannels, err := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) ([]composio.DiscordChannel, error) {
		return s.provider.ListDiscordChannels(callCtx, job.UpstreamConnectionID, identity.GuildID)
	})
	if err != nil {
		return s.handleAppProviderError(ctx, job, err)
	}
	available := make(map[string]composio.DiscordChannel, len(availableChannels))
	for _, channel := range availableChannels {
		if err := contentBudget.AddRecord(channel.ID, channel.GuildID, channel.ParentID, channel.Name); err != nil {
			return s.failImport(ctx, job, "content_too_large")
		}
		available[channel.ID] = channel
	}
	selected := make(map[string]composio.DiscordChannel, len(request.ChannelIDs))
	for _, channelID := range request.ChannelIDs {
		channel, ok := available[channelID]
		if !ok {
			return s.failImport(ctx, job, "channel_not_accessible")
		}
		selected[channelID] = channel
	}
	windowStart := job.CreatedAt.AddDate(0, 0, -request.Days)
	threads := make(map[string]composio.DiscordChannel)
	if request.IncludeThreads {
		activeThreads, listErr := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) ([]composio.DiscordChannel, error) {
			return s.provider.ListDiscordActiveThreads(callCtx, job.UpstreamConnectionID, identity.GuildID)
		})
		if listErr != nil {
			return s.handleAppProviderError(ctx, job, listErr)
		}
		for _, thread := range activeThreads {
			if err := contentBudget.AddRecord(thread.ID, thread.GuildID, thread.ParentID, thread.Name); err != nil {
				return s.failImport(ctx, job, "content_too_large")
			}
			if selected[thread.ParentID].ID != "" {
				threads[thread.ID] = thread
			}
		}
		for _, channelID := range request.ChannelIDs {
			cursor := job.CreatedAt.UTC().Format(time.RFC3339)
			for {
				if err := s.requireCurrentImport(ctx, job); err != nil {
					return err
				}
				page, pageErr := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.DiscordThreadPage, error) {
					return s.provider.ListDiscordArchivedThreads(callCtx, job.UpstreamConnectionID, identity.GuildID, channelID, cursor, 100)
				})
				if pageErr != nil {
					return s.handleAppProviderError(ctx, job, pageErr)
				}
				reachedWindow := false
				for _, thread := range page.Threads {
					if err := contentBudget.AddRecord(thread.ID, thread.GuildID, thread.ParentID, thread.Name); err != nil {
						return s.failImport(ctx, job, "content_too_large")
					}
					if thread.ParentID != channelID {
						return s.failImport(ctx, job, "provider_response_invalid")
					}
					if thread.ArchivedAt.IsZero() {
						return s.failImport(ctx, job, "provider_response_invalid")
					}
					if thread.ArchivedAt.Before(windowStart) {
						reachedWindow = true
						continue
					}
					threads[thread.ID] = thread
				}
				if reachedWindow || page.NextCursor == "" {
					break
				}
				if page.NextCursor == cursor {
					return s.failImport(ctx, job, "provider_cursor_invalid")
				}
				nextArchive, parseErr := time.Parse(time.RFC3339Nano, page.NextCursor)
				if parseErr != nil {
					return s.failImport(ctx, job, "provider_cursor_invalid")
				}
				if !nextArchive.After(windowStart) {
					break
				}
				cursor = page.NextCursor
			}
		}
	}
	messages := make([]composio.DiscordMessage, 0)
	threadList := make([]composio.DiscordChannel, 0, len(threads))
	for _, thread := range threads {
		threadList = append(threadList, thread)
	}
	sort.Slice(threadList, func(i, j int) bool { return threadList[i].ID < threadList[j].ID })
	for _, channelID := range request.ChannelIDs {
		targets := make([]composio.DiscordChannel, 0, 1+len(threadList))
		if selected[channelID].Type == 0 || selected[channelID].Type == 5 {
			targets = append(targets, selected[channelID])
		}
		for _, thread := range threadList {
			if thread.ParentID == channelID {
				targets = append(targets, thread)
			}
		}
		channelCount := 0
		for _, target := range targets {
			before := ""
			for channelCount < request.MaxMessagesPerChannel {
				if err := s.requireCurrentImport(ctx, job); err != nil {
					return err
				}
				limit := min(100, request.MaxMessagesPerChannel-channelCount)
				page, pageErr := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.DiscordMessagePage, error) {
					return s.provider.ListDiscordMessages(callCtx, job.UpstreamConnectionID, target.ID, before, limit)
				})
				if pageErr != nil {
					return s.handleAppProviderError(ctx, job, pageErr)
				}
				reachedStart := false
				for _, message := range page.Messages {
					if message.Timestamp.Before(windowStart) {
						reachedStart = true
						continue
					}
					if err := addDiscordMessageContent(contentBudget, message); err != nil {
						return s.failImport(ctx, job, "content_too_large")
					}
					message.ParentChannelID = channelID
					message.ChannelName = selected[channelID].Name
					if target.ID != channelID {
						message.ThreadName = target.Name
					}
					messages = append(messages, message)
					channelCount++
					if channelCount == request.MaxMessagesPerChannel {
						break
					}
				}
				if reachedStart || page.NextBefore == "" || channelCount == request.MaxMessagesPerChannel {
					break
				}
				if page.NextBefore == before {
					return s.failImport(ctx, job, "provider_cursor_invalid")
				}
				before = page.NextBefore
			}
			if channelCount == request.MaxMessagesPerChannel {
				break
			}
		}
	}
	documents, err := composio.RenderDiscordDocumentsWithLimits(identity, selected, messages, s.appImportLimits)
	if err != nil {
		if errors.Is(err, composio.ErrAppImportTooLarge) {
			return s.failImport(ctx, job, "content_too_large")
		}
		return s.failImport(ctx, job, "provider_response_invalid")
	}
	return s.commitAppDocuments(ctx, job, documents, false)
}

func (s *Service) executeGitHubJob(ctx context.Context, job *importRun) error {
	var request GitHubImportRequest
	if err := json.Unmarshal(job.Request, &request); err != nil || len(request.Repositories) > 5 || s.provider == nil {
		return s.failImport(ctx, job, "invalid_request")
	}
	identity, err := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.GitHubIdentity, error) {
		return s.provider.IdentifyGitHub(callCtx, job.UpstreamConnectionID)
	})
	if err != nil {
		return s.handleAppProviderError(ctx, job, err)
	}
	if ok, matchErr := s.importIdentityMatches(ctx, job, "github:"+identity.UserID); matchErr != nil || !ok {
		return ErrStaleRevision
	}
	available := map[string]composio.GitHubRepository{}
	cursor := ""
	for !allSelectedGitHubRepositoriesAvailable(available, request.Repositories) {
		page, pageErr := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.GitHubRepositoryPage, error) {
			return s.provider.ListGitHubRepositories(callCtx, job.UpstreamConnectionID, identity, cursor, 100)
		})
		if pageErr != nil {
			return s.handleAppProviderError(ctx, job, pageErr)
		}
		for _, repository := range page.Repositories {
			available[repository.RepositoryID] = repository
		}
		if page.NextCursor == "" {
			break
		}
		if page.NextCursor == cursor {
			return s.failImport(ctx, job, "provider_cursor_invalid")
		}
		cursor = page.NextCursor
	}
	snapshots := make([]composio.GitHubRepositorySnapshot, 0, len(request.Repositories))
	for _, selection := range request.Repositories {
		repository, ok := available[selection.RepositoryID]
		if !ok || repository.FullName != selection.FullName || repository.OwnerID != identity.UserID {
			return s.failImport(ctx, job, "repository_not_accessible")
		}
		readme, readmeErr := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (*composio.GitHubReadme, error) {
			return s.provider.GetGitHubReadme(callCtx, job.UpstreamConnectionID, repository)
		})
		if readmeErr != nil {
			return s.handleAppProviderError(ctx, job, readmeErr)
		}
		snapshots = append(snapshots, composio.GitHubRepositorySnapshot{Repository: repository, Readme: readme})
	}
	documents, err := composio.RenderGitHubDocumentsWithLimits(identity, snapshots, s.appImportLimits)
	if err != nil {
		if errors.Is(err, composio.ErrAppImportTooLarge) {
			return s.failImport(ctx, job, "content_too_large")
		}
		return s.failImport(ctx, job, "provider_response_invalid")
	}
	return s.commitAppDocuments(ctx, job, documents, false)
}

func allSelectedGitHubRepositoriesAvailable(available map[string]composio.GitHubRepository, selections []GitHubRepositorySelection) bool {
	for _, selection := range selections {
		if _, exists := available[selection.RepositoryID]; !exists {
			return false
		}
	}
	return true
}

func (s *Service) executeNotionJob(ctx context.Context, job *importRun) error {
	var request NotionImportRequest
	if err := json.Unmarshal(job.Request, &request); err != nil || len(request.Resources) < 1 || len(request.Resources) > 10 || s.provider == nil {
		return s.failImport(ctx, job, "invalid_request")
	}
	identity, err := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.NotionIdentity, error) {
		return s.provider.IdentifyNotion(callCtx, job.UpstreamConnectionID)
	})
	if err != nil {
		return s.handleAppProviderError(ctx, job, err)
	}
	if ok, matchErr := s.importIdentityMatches(ctx, job, "notion:"+identity.BotID); matchErr != nil || !ok {
		return ErrStaleRevision
	}
	available := map[string]composio.NotionResource{}
	cursor := ""
	for {
		page, pageErr := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.NotionResourcePage, error) {
			return s.provider.ListNotionResources(callCtx, job.UpstreamConnectionID, cursor, 50)
		})
		if pageErr != nil {
			return s.handleAppProviderError(ctx, job, pageErr)
		}
		for _, resource := range page.Resources {
			available[resource.ID] = resource
		}
		if page.NextCursor == "" {
			break
		}
		if page.NextCursor == cursor {
			return s.failImport(ctx, job, "provider_cursor_invalid")
		}
		cursor = page.NextCursor
	}
	snapshots := make([]composio.NotionSnapshot, 0, len(request.Resources))
	skipped := 0
	for _, selection := range request.Resources {
		resource, ok := available[selection.ResourceID]
		if !ok || resource.Kind != selection.Kind {
			skipped++
			continue
		}
		var snapshot composio.NotionSnapshot
		var fetchErr error
		if selection.Kind == "notion_page" {
			snapshot, fetchErr = appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.NotionSnapshot, error) {
				return s.provider.GetNotionPage(callCtx, job.UpstreamConnectionID, resource)
			})
		} else {
			snapshot, fetchErr = appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.NotionSnapshot, error) {
				return s.provider.GetNotionDatabase(callCtx, job.UpstreamConnectionID, resource)
			})
		}
		if fetchErr != nil {
			if status, ok := composio.ErrorStatus(fetchErr); ok && (status == http.StatusForbidden || status == http.StatusNotFound) {
				skipped++
				continue
			}
			return s.handleAppProviderError(ctx, job, fetchErr)
		}
		snapshots = append(snapshots, snapshot)
	}
	if len(snapshots) == 0 {
		return s.completeImport(ctx, job, nil, 0, false)
	}
	documents, err := composio.RenderNotionDocumentsWithLimits(identity, snapshots, s.appImportLimits)
	if err != nil {
		if errors.Is(err, composio.ErrAppImportTooLarge) {
			return s.failImport(ctx, job, "content_too_large")
		}
		return s.failImport(ctx, job, "provider_response_invalid")
	}
	return s.commitAppDocuments(ctx, job, documents, skipped > 0)
}

func (s *Service) executeGoogleCalendarJob(ctx context.Context, job *importRun) error {
	var request GoogleCalendarImportRequest
	if err := json.Unmarshal(job.Request, &request); err != nil {
		return s.failImport(ctx, job, "invalid_request")
	}
	remaining := job.ProviderCallBudget
	if remaining < 3 || s.provider == nil {
		return s.failImport(ctx, job, "provider_call_budget_exhausted")
	}
	if err := s.requireCurrentImport(ctx, job); err != nil {
		return err
	}
	contentBudget := composio.NewAppImportAccumulator(s.appImportLimits)
	identity, err := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.GoogleCalendarIdentity, error) {
		return s.provider.IdentifyGoogleCalendar(callCtx, job.UpstreamConnectionID)
	})
	if err != nil {
		return s.handleAppProviderError(ctx, job, err)
	}
	if err := contentBudget.AddRecord(identity.CalendarID, identity.Label, identity.TimeZone); err != nil {
		return s.failImport(ctx, job, "content_too_large")
	}
	if ok, matchErr := s.importIdentityMatches(ctx, job, "google_calendar:"+identity.CalendarID); matchErr != nil || !ok {
		return ErrStaleRevision
	}
	available := map[string]composio.GoogleCalendar{}
	pageToken := ""
	for {
		if err := s.requireCurrentImport(ctx, job); err != nil {
			return err
		}
		page, pageErr := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.GoogleCalendarPage, error) {
			return s.provider.ListGoogleCalendars(callCtx, job.UpstreamConnectionID, pageToken, 250)
		})
		if pageErr != nil {
			return s.handleAppProviderError(ctx, job, pageErr)
		}
		for _, calendar := range page.Calendars {
			if err := contentBudget.AddRecord(calendar.ID, calendar.Summary, calendar.TimeZone, calendar.AccessRole); err != nil {
				return s.failImport(ctx, job, "content_too_large")
			}
			available[calendar.ID] = calendar
		}
		if page.NextPageToken == "" {
			break
		}
		if page.NextPageToken == pageToken {
			return s.failImport(ctx, job, "provider_cursor_invalid")
		}
		pageToken = page.NextPageToken
	}
	for i, id := range request.CalendarIDs {
		if id == "primary" {
			request.CalendarIDs[i] = identity.CalendarID
		}
	}
	selected := make(map[string]composio.GoogleCalendar, len(request.CalendarIDs))
	for _, calendarID := range request.CalendarIDs {
		calendar, ok := available[calendarID]
		if !ok {
			return s.failImport(ctx, job, "calendar_not_accessible")
		}
		selected[calendarID] = calendar
	}
	windowStart := job.CreatedAt.AddDate(0, 0, -request.Days)
	events := make(map[string][]composio.GoogleCalendarEvent, len(selected))
	for _, calendarID := range request.CalendarIDs {
		pageToken = ""
		for len(events[calendarID]) < request.MaxEventsPerCalendar {
			if err := s.requireCurrentImport(ctx, job); err != nil {
				return err
			}
			limit := min(250, request.MaxEventsPerCalendar-len(events[calendarID]))
			page, pageErr := appProviderCall(ctx, s, job, s.provider, func(callCtx context.Context) (composio.GoogleCalendarEventPage, error) {
				return s.provider.ListGoogleCalendarEvents(callCtx, job.UpstreamConnectionID, calendarID, pageToken, windowStart, job.CreatedAt, limit)
			})
			if pageErr != nil {
				return s.handleAppProviderError(ctx, job, pageErr)
			}
			for _, event := range page.Events {
				if err := addGoogleCalendarEventContent(contentBudget, event); err != nil {
					return s.failImport(ctx, job, "content_too_large")
				}
				events[calendarID] = append(events[calendarID], event)
			}
			if len(events[calendarID]) > request.MaxEventsPerCalendar {
				events[calendarID] = events[calendarID][:request.MaxEventsPerCalendar]
			}
			if page.NextPageToken == "" || len(events[calendarID]) == request.MaxEventsPerCalendar {
				break
			}
			if page.NextPageToken == pageToken {
				return s.failImport(ctx, job, "provider_cursor_invalid")
			}
			pageToken = page.NextPageToken
		}
	}
	documents, err := composio.RenderGoogleCalendarDocumentsWithLimits(identity, selected, events, s.appImportLimits)
	if err != nil {
		if errors.Is(err, composio.ErrAppImportTooLarge) {
			return s.failImport(ctx, job, "content_too_large")
		}
		return s.failImport(ctx, job, "provider_response_invalid")
	}
	return s.commitAppDocuments(ctx, job, documents, false)
}

func (s *Service) importIdentityMatches(ctx context.Context, job *importRun, principalKey string) (bool, error) {
	var matches bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM external_connections WHERE id=$1 AND account_id=$2 AND status='active' AND revision=$3 AND remote_principal_key=$4)`, job.ConnectionID, job.AccountID, job.ConnectionRevision, principalKey).Scan(&matches)
	return matches, err
}

func addDiscordMessageContent(budget *composio.AppImportAccumulator, message composio.DiscordMessage) error {
	if err := budget.AddRecord(message.ID, message.ChannelID, message.ParentChannelID, message.ChannelName, message.ThreadName, message.Content, message.AuthorID, message.AuthorName); err != nil {
		return err
	}
	for _, attachment := range message.Attachments {
		if err := budget.AddRecord(attachment.ID, attachment.Filename, attachment.URL); err != nil {
			return err
		}
	}
	return nil
}

func addGoogleCalendarEventContent(budget *composio.AppImportAccumulator, event composio.GoogleCalendarEvent) error {
	if err := budget.AddRecord(
		event.ID, event.ICalUID, event.Status, event.Summary, event.Description, event.Location, event.SourceURL,
		event.HangoutLink, event.EventType, event.Visibility, event.RecurringEventID,
		event.StartDate, event.StartDateTime, event.StartTimeZone, event.EndDate, event.EndDateTime, event.EndTimeZone,
		event.OriginalStartDate, event.OriginalStartDateTime, event.OriginalStartTimeZone,
	); err != nil {
		return err
	}
	people := append([]composio.GoogleCalendarPerson{event.Creator, event.Organizer}, event.Attendees...)
	for _, person := range people {
		if err := budget.AddRecord(person.ID, person.Email, person.DisplayName, person.ResponseStatus); err != nil {
			return err
		}
	}
	for _, recurrence := range event.Recurrence {
		if err := budget.AddRecord(recurrence); err != nil {
			return err
		}
	}
	for _, attachment := range event.Attachments {
		if err := budget.AddRecord(attachment.ID, attachment.Title, attachment.URL); err != nil {
			return err
		}
	}
	return nil
}

// commitAppDocuments completes a connection import with its rendered documents.
// Partial marks an import that skipped selections it could not read.
func (s *Service) commitAppDocuments(ctx context.Context, job *importRun, documents []composio.AppDocument, partial bool) error {
	return s.completeImport(ctx, job, documents, len(documents), partial && len(documents) > 0)
}
