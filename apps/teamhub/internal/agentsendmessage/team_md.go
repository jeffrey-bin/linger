package agentsendmessage

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/teammd"
)

const (
	createTeamMdToolName    = "create_team_md"
	createTeamMdIdempotency = "create_team_md"
	// The announcement is Agent-only. agent_runtime Messages are projected into
	// every member's Inbox and still carry Mentions, but the Human timeline,
	// unread counts, and Web never list them.
	teamMdMessageKind = "agent_runtime"
	// Humans learn of a publication from this Room Event instead.
	teamMdPublishedEventType = "team_md.published"
)

// DocumentInvalidError reports every rule a submitted team.md broke. TeamHub
// rejects the whole submission: nothing is written and nobody is notified.
type DocumentInvalidError struct {
	Issues []teammd.Issue
}

func (e *DocumentInvalidError) Error() string {
	return fmt.Sprintf("team.md document is invalid (%d issues)", len(e.Issues))
}

type CreateTeamMdInput struct {
	SourceInboxIDs []string
	InvocationID   string
	Content        string
}

// TeamMdResult is the persisted team.md plus the Message that notified the team.
type TeamMdResult struct {
	Result
	RoomID           string
	Revision         int64
	NotifiedActorIDs []string
}

type teamMdPersistedResult struct {
	persistedResult
	RoomID           string   `json:"room_id"`
	Revision         int64    `json:"revision"`
	NotifiedActorIDs []string `json:"notified_actor_ids"`
}

type teamMdCanonicalRequest struct {
	SourceInboxIDs []string `json:"source_inbox_ids"`
	Content        string   `json:"content"`
}

// CreateTeamMd validates one teamMD document against the calling Context's Room,
// replaces that Room's team.md, appends team_md.published for the Room's
// Humans, and publishes one Agent-only Message that Mentions every declared
// participant except the publisher so each one wakes.
// This includes an Orchestrator appointed by another Agent. Humans never see that Message,
// so it is neither a visible reply of the Run nor a Runtime presentation output.
func (s *Service) CreateTeamMd(
	ctx context.Context,
	contextToken string,
	input CreateTeamMdInput,
) (TeamMdResult, error) {
	invocationID := strings.TrimSpace(input.InvocationID)
	if !invocationPattern.MatchString(invocationID) || strings.TrimSpace(input.Content) == "" {
		return TeamMdResult{}, ErrInvalid
	}
	if s == nil || s.pool == nil || s.authorizer == nil {
		return TeamMdResult{}, ErrUnavailable
	}
	// Structural rules need no Room context, so a malformed document never
	// reaches the database.
	document, issues := teammd.Parse(input.Content)
	if len(issues) > 0 {
		return TeamMdResult{}, &DocumentInvalidError{Issues: issues}
	}
	canonicalRequest, err := json.Marshal(teamMdCanonicalRequest{
		SourceInboxIDs: append([]string{}, input.SourceInboxIDs...),
		Content:        input.Content,
	})
	if err != nil {
		return TeamMdResult{}, err
	}
	canonicalDigest := sha256.Sum256(canonicalRequest)
	requestHash := canonicalDigest[:]

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TeamMdResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	authorization, err := s.authorizer.AuthorizeInTx(
		ctx, tx, contextToken, createTeamMdToolName,
	)
	if err != nil {
		return TeamMdResult{}, err
	}
	// team.md belongs to the currently authorized Room.
	if authorization.RoomID == "" {
		return TeamMdResult{}, ErrForbidden
	}
	roomID := authorization.RoomID

	queries := store.New(tx)
	idempotencyKey := agentauth.IdempotencyKey(createTeamMdIdempotency, invocationID)
	if err := idempotency.Lock(ctx, tx, idempotency.AgentKey(authorization.AgentActorID, createTeamMdIdempotency, idempotencyKey)); err != nil {
		return TeamMdResult{}, err
	}
	replayRecord, replayFound, err := lookupReplayRecord(
		ctx, tx, authorization.AgentActorID, createTeamMdIdempotency, idempotencyKey, requestHash,
	)
	if err != nil {
		return TeamMdResult{}, err
	}
	resolved, err := resolveTarget(ctx, queries, authorization, inboxTarget{
		kind: "room", id: roomID, raw: "room:" + roomID,
	})
	if err != nil {
		return TeamMdResult{}, err
	}
	if replayFound {
		var stored teamMdPersistedResult
		if err := json.Unmarshal(replayRecord.Body, &stored); err != nil {
			return TeamMdResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return TeamMdResult{}, err
		}
		return teamMdResultFrom(stored, true), nil
	}
	// Rule 5: every declared Actor must be an active member of this Room. The
	// query returns only the members, so Validate names the ones that are not.
	declared := document.ActorIDs()
	memberRows, err := queries.ListRoomMentionTargets(ctx, store.ListRoomMentionTargetsParams{
		RoomID: roomID, ActorIds: declared,
	})
	if err != nil {
		return TeamMdResult{}, err
	}
	memberActorIDs := make([]string, 0, len(memberRows))
	displayNames := make(map[string]string, len(memberRows))
	for _, member := range memberRows {
		if member.Kind != "agent" {
			continue
		}
		memberActorIDs = append(memberActorIDs, member.ID)
		displayNames[member.ID] = member.DisplayName
	}
	if issues := teammd.Validate(document, memberActorIDs); len(issues) > 0 {
		return TeamMdResult{}, &DocumentInvalidError{Issues: issues}
	}

	encodedDocument, err := json.Marshal(document)
	if err != nil {
		return TeamMdResult{}, err
	}
	upserted, err := queries.UpsertRoomTeamDocument(ctx, store.UpsertRoomTeamDocumentParams{
		RoomID: roomID, TenantID: resolved.tenantID, RawMarkdown: input.Content,
		CollaboratePattern: string(document.Pattern), Document: encodedDocument,
		UpdatedByActorID: resolved.author.ID,
	})
	if err != nil {
		return TeamMdResult{}, err
	}
	if _, err := roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: resolved.tenantID, RoomID: roomID, EventType: teamMdPublishedEventType,
		ActorID: resolved.author.ID, ResourceID: roomID,
		Payload: map[string]any{"kind": teamMdPublishedEventType, "revision": upserted.Revision},
	}); err != nil {
		return TeamMdResult{}, err
	}

	content, notified := teamMdMessageContent(document, resolved.author.ID, displayNames)
	created, err := messagecreation.Create(ctx, queries, messagecreation.Draft{
		TenantID: resolved.tenantID, RoomID: resolved.roomID, Author: resolved.author,
		Content: content, Kind: teamMdMessageKind,
	})
	if err != nil {
		if errors.Is(err, messagecreation.ErrInvalid) ||
			errors.Is(err, messagecreation.ErrInvalidReference) ||
			errors.Is(err, messagecreation.ErrInvalidSkill) {
			return TeamMdResult{}, ErrInvalid
		}
		return TeamMdResult{}, err
	}
	// The Agent Notification Manager renders the collaboration-mode reminder
	// from this pattern. It travels in canonical messages.json only.
	if err := queries.MarkMessageTeamProtocol(ctx, store.MarkMessageTeamProtocolParams{
		CollaboratePattern: string(document.Pattern),
		MessageID:          created.Message.ID, TenantID: resolved.tenantID,
	}); err != nil {
		return TeamMdResult{}, err
	}
	stored := teamMdPersistedResult{
		persistedResult: persistedResult{
			Accepted: true, InboxID: resolved.inboxID, MessageID: created.Message.ID,
		},
		RoomID:   roomID,
		Revision: upserted.Revision, NotifiedActorIDs: notified,
	}
	responseBody, err := json.Marshal(stored)
	if err != nil {
		return TeamMdResult{}, err
	}
	if err := idempotency.Save(ctx, tx, idempotency.AgentKey(resolved.author.ID, createTeamMdIdempotency, idempotencyKey),
		requestHash, idempotency.Record{ResourceID: created.Message.ID, Status: http.StatusOK, Body: responseBody}); err != nil {
		return TeamMdResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TeamMdResult{}, err
	}
	return teamMdResultFrom(stored, false), nil
}

// teamMdMessageContent selects recipients and builds the Agent-only announcement. It stays short: the
// Notification Manager renders the full collaboration-mode reminder, including
// the pattern and how to read the protocol, from the team_protocol flag.
func teamMdMessageContent(
	document teammd.Document,
	publisherActorID string,
	displayNames map[string]string,
) (messagecreation.Content, []string) {
	notified := make([]string, 0, len(document.Members)+1)
	for _, actorID := range document.ActorIDs() {
		if actorID != publisherActorID {
			notified = append(notified, actorID)
		}
	}
	segments := []messagecreation.Segment{{
		Type:    "text",
		Content: fmt.Sprintf("Collaboration protocol published (%s). ", document.Pattern),
	}}
	for index, actorID := range notified {
		if index > 0 {
			segments = append(segments, messagecreation.Segment{Type: "text", Content: " "})
		}
		name := displayNames[actorID]
		if name == "" {
			name = actorID
		}
		segments = append(segments, messagecreation.Segment{
			Type: "reference", Content: "@" + name, Target: actorID, TargetType: "agent",
		})
	}
	raw := strings.Builder{}
	for _, segment := range segments {
		raw.WriteString(segment.Content)
	}
	return messagecreation.Content{Segments: segments, RawMessage: raw.String()}, notified
}

func teamMdResultFrom(stored teamMdPersistedResult, replay bool) TeamMdResult {
	return TeamMdResult{
		Result:           resultFromPersisted(stored.persistedResult, replay),
		RoomID:           stored.RoomID,
		Revision:         stored.Revision,
		NotifiedActorIDs: append([]string(nil), stored.NotifiedActorIDs...),
	}
}
