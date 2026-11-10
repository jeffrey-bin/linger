package agentcreationapproval

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

const (
	createRoomTool          = "create_room"
	listAvailableAgentsTool = "list_available_agents"
)

var (
	ErrInvalid             = errors.New("Agent Creation approval input is invalid")
	ErrNotFound            = errors.New("Agent Creation approval target is unavailable")
	ErrForbidden           = errors.New("Agent Creation approval is forbidden")
	ErrConflict            = errors.New("Agent Creation approval payload conflicts with TeamHub authority")
	ErrIdempotencyConflict = errors.New("Agent Creation invocation was reused with different caller input")
	ErrUnavailable         = errors.New("Agent Creation approval service is unavailable")

	idPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	invocationPattern = regexp.MustCompile(`^agent-invocation-sha256:[a-f0-9]{64}$`)
)

type RoomCallerInput struct {
	Name                   string                    `json:"name"`
	Description            *string                   `json:"description,omitempty"`
	MemberIDs              []string                  `json:"member_ids"`
	Artifacts              []string                  `json:"artifacts,omitempty"`
	InitialMessageSegments []messagecreation.Segment `json:"initial_message_segments"`
}

type RoomEffectivePayload struct {
	Name                   string                    `json:"name"`
	Description            *string                   `json:"description,omitempty"`
	MemberIDs              []string                  `json:"member_ids"`
	Artifacts              []string                  `json:"artifacts,omitempty"`
	InitialMessageSegments []messagecreation.Segment `json:"initial_message_segments"`
}

type Input struct {
	RequestKind    string
	RoomCaller     *RoomCallerInput
	RoomEffective  *RoomEffectivePayload
	SourceInboxIDs []string
	InvocationID   string
	// CallerInputJSON and EffectivePayloadJSON preserve optional-field presence
	// from the strict OpenAPI boundary. Domain callers may leave them empty.
	CallerInputJSON      json.RawMessage
	EffectivePayloadJSON json.RawMessage
}

type AvailableAgent struct {
	ActorID     string
	Name        string
	Description string
}

type AvailableAgentPage struct {
	Agents     []AvailableAgent
	NextCursor string
}

type Result struct {
	CreationApprovalRequestID string
	MessageID                 string
	Replay                    bool
}

type normalizedInput struct {
	Input
	toolName        string
	callerInputJSON json.RawMessage
	effectiveJSON   json.RawMessage
	callerInputHash [sha256.Size]byte
}

type submissionContext struct {
	authorization agentauth.Authorization
	roomID        string
	submissionID  string
	operation     string
}

type Service struct {
	pool     *pgxpool.Pool
	contexts *agentauth.Service
	cards    *typedcard.Service
}

func New(pool *pgxpool.Pool, contexts *agentauth.Service, cards *typedcard.Service) *Service {
	return &Service{pool: pool, contexts: contexts, cards: cards}
}

func (s *Service) ListAvailableAgents(
	ctx context.Context,
	token string,
	cursor string,
	limit int,
) (AvailableAgentPage, error) {
	if s == nil || s.pool == nil || s.contexts == nil ||
		(cursor != "" && !idPattern.MatchString(cursor)) || limit < 1 || limit > 100 {
		return AvailableAgentPage{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AvailableAgentPage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	authorization, err := s.contexts.AuthorizeInTx(ctx, tx, token, listAvailableAgentsTool)
	if err != nil {
		return AvailableAgentPage{}, err
	}
	identity := authorization
	queries := store.New(tx)
	sponsorActorID, err := queries.GetAgentSponsor(ctx, store.GetAgentSponsorParams{
		TenantID: identity.TenantID, AgentActorID: identity.AgentActorID,
		AgentManagementID: identity.AgentID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return AvailableAgentPage{}, ErrForbidden
	}
	if err != nil {
		return AvailableAgentPage{}, err
	}
	rows, err := queries.ListAgentSponsorAvailableAgents(ctx, store.ListAgentSponsorAvailableAgentsParams{
		TenantID: identity.TenantID, SponsorActorID: sponsorActorID,
		Cursor: cursor, PageLimit: int32(limit + 1),
	})
	if err != nil {
		return AvailableAgentPage{}, err
	}
	nextCursor := ""
	if len(rows) > limit {
		rows = rows[:limit]
		nextCursor = rows[len(rows)-1].ActorID
	}
	agents := make([]AvailableAgent, 0, len(rows))
	for _, row := range rows {
		if !idPattern.MatchString(row.ActorID) || strings.TrimSpace(row.Name) == "" ||
			utf8.RuneCountInString(row.Name) > 120 || utf8.RuneCountInString(row.Description) > 1000 {
			return AvailableAgentPage{}, ErrUnavailable
		}
		agents = append(agents, AvailableAgent{
			ActorID: row.ActorID, Name: row.Name, Description: row.Description,
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return AvailableAgentPage{}, err
	}
	return AvailableAgentPage{
		Agents: agents, NextCursor: nextCursor,
	}, nil
}

func (s *Service) Submit(
	ctx context.Context,
	token string,
	input Input,
) (Result, error) {
	normalized, err := normalizeInput(input)
	if err != nil {
		return Result{}, err
	}
	if s == nil || s.pool == nil || s.contexts == nil || s.cards == nil {
		return Result{}, ErrUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	resolved, err := s.authorizeSubmission(ctx, tx, token, normalized)
	if err != nil {
		return Result{}, err
	}
	created, err := s.cards.CreateCreationApprovalRequestInTx(ctx, tx, typedcard.CreationApprovalInTxInput{
		RoomID: resolved.roomID, AgentManagementID: resolved.authorization.AgentID,
		ExpectedAgentActorID: resolved.authorization.AgentActorID,
		ExpectedTenantID:     resolved.authorization.TenantID,
		IdempotencyOperation: resolved.operation,
		CallerInputHash:      normalized.callerInputHash[:],
		Submission: typedcard.CreationApprovalSubmission{
			SubmissionID: resolved.submissionID,
			CallerInput:  normalized.callerInputJSON, EffectivePayload: normalized.effectiveJSON,
			FulfillmentSnapshot: json.RawMessage(`{}`),
		},
		BeforeCreate: func(
			ctx context.Context,
			queries *store.Queries,
			source typedcard.CreationApprovalSource,
			submission *typedcard.CreationApprovalSubmission,
		) error {
			if source.TenantID != resolved.authorization.TenantID ||
				source.AgentActorID != resolved.authorization.AgentActorID ||
				source.AgentManagementID != resolved.authorization.AgentID {
				return ErrForbidden
			}
			snapshot, err := freezeRoomSnapshot(ctx, queries, source, resolved.roomID, *normalized.RoomEffective)
			if err != nil {
				return err
			}
			submission.FulfillmentSnapshot = snapshot
			return nil
		},
	})
	if err != nil {
		return Result{}, mapTypedCardError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{
		CreationApprovalRequestID: created.DecisionID,
		MessageID:                 created.MessageID, Replay: created.Replay,
	}, nil
}

func (s *Service) authorizeSubmission(
	ctx context.Context,
	tx pgx.Tx,
	token string,
	input normalizedInput,
) (submissionContext, error) {
	authorization, err := s.contexts.AuthorizeInTx(ctx, tx, token, input.toolName)
	if err != nil {
		return submissionContext{}, err
	}
	queries := store.New(tx)
	roomID := authorization.RoomID
	for _, inboxID := range input.SourceInboxIDs {
		sourceRoomID := strings.TrimPrefix(inboxID, "room:")
		if roomID == "" {
			roomID = sourceRoomID
		} else if sourceRoomID != roomID {
			return submissionContext{}, ErrForbidden
		}
	}
	if !agentauth.AllowsRoomTarget(authorization, roomID) {
		return submissionContext{}, ErrForbidden
	}
	activeRoomID, err := queries.LockActiveRoomForMutation(ctx, roomID)
	if errors.Is(err, pgx.ErrNoRows) {
		return submissionContext{}, ErrNotFound
	}
	if err != nil {
		return submissionContext{}, err
	}
	if activeRoomID != roomID {
		return submissionContext{}, ErrUnavailable
	}
	agent, err := queries.ResolveCreationApprovalAgentSource(ctx, store.ResolveCreationApprovalAgentSourceParams{
		RoomID: roomID, AgentManagementID: authorization.AgentID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return submissionContext{}, ErrForbidden
	}
	if err != nil {
		return submissionContext{}, err
	}
	if agent.TenantID != authorization.TenantID ||
		agent.AgentActorID != authorization.AgentActorID ||
		!agent.AgentManagementID.Valid || agent.AgentManagementID.String != authorization.AgentID {
		return submissionContext{}, ErrForbidden
	}
	return submissionContext{
		authorization: authorization, roomID: roomID,
		submissionID: deriveSubmissionID(authorization, input),
		operation:    input.toolName,
	}, nil
}

func freezeRoomSnapshot(
	ctx context.Context,
	queries *store.Queries,
	source typedcard.CreationApprovalSource,
	originRoomID string,
	effective RoomEffectivePayload,
) (json.RawMessage, error) {
	actors, err := resolveAndValidateActors(ctx, queries, source.TenantID, effective.MemberIDs)
	if err != nil {
		return nil, err
	}
	if err := validateReferences(effective.InitialMessageSegments, actors, map[string]string{
		source.AgentActorID: "agent", source.DecisionOwner.ID: "user",
	}); err != nil {
		return nil, err
	}
	artifacts, segments, err := freezeRoomArtifacts(
		ctx, queries, source.TenantID, originRoomID, effective.Artifacts,
		effective.InitialMessageSegments,
	)
	if err != nil {
		return nil, err
	}
	return json.Marshal(typedcard.RoomCreationSnapshot{
		OriginRoomID: originRoomID, Name: effective.Name, Description: effective.Description,
		MemberIDs:              append([]string(nil), effective.MemberIDs...),
		Artifacts:              artifacts,
		InitialMessageSegments: segments,
	})
}

func freezeRoomArtifacts(
	ctx context.Context,
	queries *store.Queries,
	tenantID, originRoomID string,
	documentIDs []string,
	initialSegments []messagecreation.Segment,
) ([]typedcard.RoomCreationArtifactSnapshot, []messagecreation.Segment, error) {
	segments := append([]messagecreation.Segment(nil), initialSegments...)
	if len(documentIDs) == 0 {
		return nil, segments, nil
	}
	versions, err := queries.LockAgentRoomCreationFileArtifactHeads(
		ctx, store.LockAgentRoomCreationFileArtifactHeadsParams{
			RoomID: originRoomID, DocumentIds: documentIDs, TenantID: tenantID,
		},
	)
	if err != nil {
		return nil, nil, err
	}
	revisions, err := queries.LockAgentRoomCreationNativeArtifactHeads(
		ctx, store.LockAgentRoomCreationNativeArtifactHeadsParams{
			RoomID: originRoomID, DocumentIds: documentIDs, TenantID: tenantID,
		},
	)
	if err != nil {
		return nil, nil, err
	}
	versionByDocument := make(map[string]store.LockAgentRoomCreationFileArtifactHeadsRow, len(versions))
	for _, version := range versions {
		if version.DocumentID == "" || version.DocumentVersionID == "" ||
			strings.TrimSpace(version.Filename) == "" || strings.TrimSpace(version.MediaType) == "" {
			return nil, nil, ErrConflict
		}
		if _, exists := versionByDocument[version.DocumentID]; exists {
			return nil, nil, ErrConflict
		}
		versionByDocument[version.DocumentID] = version
	}
	revisionByDocument := make(map[string]store.LockAgentRoomCreationNativeArtifactHeadsRow, len(revisions))
	for _, revision := range revisions {
		if revision.DocumentID == "" || revision.DocumentRevisionID == "" || strings.TrimSpace(revision.Title) == "" {
			return nil, nil, ErrConflict
		}
		if _, exists := revisionByDocument[revision.DocumentID]; exists {
			return nil, nil, ErrConflict
		}
		revisionByDocument[revision.DocumentID] = revision
	}
	artifacts := make([]typedcard.RoomCreationArtifactSnapshot, 0, len(documentIDs))
	for _, documentID := range documentIDs {
		version, hasVersion := versionByDocument[documentID]
		revision, hasRevision := revisionByDocument[documentID]
		if hasVersion == hasRevision {
			return nil, nil, ErrConflict
		}
		artifact := typedcard.RoomCreationArtifactSnapshot{DocumentID: documentID}
		var content string
		if hasVersion {
			artifact.DocumentVersionID = version.DocumentVersionID
			content = version.Filename
		} else {
			artifact.DocumentRevisionID = revision.DocumentRevisionID
			content = revision.Title
		}
		artifacts = append(artifacts, artifact)
		segments = append(segments,
			messagecreation.Segment{Type: "text", Content: "\n"},
			messagecreation.Segment{
				Type: "document", Content: content,
				DocumentID: documentID, Presentation: "card",
			},
		)
	}
	if _, err := messagecreation.Normalize(segments); err != nil {
		return nil, nil, ErrConflict
	}
	return artifacts, segments, nil
}

func resolveAndValidateActors(
	ctx context.Context,
	queries *store.Queries,
	tenantID string,
	actorIDs []string,
) (map[string]store.ResolveAgentCreationActorsRow, error) {
	rows, err := queries.ResolveAgentCreationActors(ctx, store.ResolveAgentCreationActorsParams{
		TenantID: tenantID, ActorIds: actorIDs,
	})
	if err != nil {
		return nil, err
	}
	if len(rows) != len(actorIDs) {
		return nil, ErrConflict
	}
	result := make(map[string]store.ResolveAgentCreationActorsRow, len(rows))
	for index, row := range rows {
		if row.ID != actorIDs[index] || row.Kind != "human" && row.Kind != "agent" {
			return nil, ErrConflict
		}
		if row.Kind == "agent" && (!row.AgentManagementID.Valid || row.RegistrationStatus != "active") {
			return nil, ErrConflict
		}
		result[row.ID] = row
	}
	return result, nil
}

func validateReferences(
	segments []messagecreation.Segment,
	actors map[string]store.ResolveAgentCreationActorsRow,
	extraActorKinds map[string]string,
) error {
	for _, segment := range segments {
		if segment.Type != "reference" {
			continue
		}
		if row, found := actors[segment.Target]; found {
			expected := "user"
			if row.Kind == "agent" {
				expected = "agent"
			}
			if segment.TargetType != expected {
				return ErrConflict
			}
			continue
		}
		if expected, found := extraActorKinds[segment.Target]; !found || segment.TargetType != expected {
			return ErrConflict
		}
	}
	return nil
}

func preserveWireJSON(raw json.RawMessage, fallback any) (json.RawMessage, error) {
	if len(raw) == 0 {
		return json.Marshal(fallback)
	}
	if !json.Valid(raw) {
		return nil, ErrInvalid
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, ErrInvalid
	}
	return append(json.RawMessage(nil), raw...), nil
}

func validCreationSegments(segments []messagecreation.Segment) bool {
	for _, segment := range segments {
		if segment.Type != "text" && segment.Type != "reference" {
			return false
		}
	}
	_, err := messagecreation.Normalize(segments)
	return err == nil
}

func optionalStringTooLong(value *string, maximum int) bool {
	return value != nil && utf8.RuneCountInString(*value) > maximum
}

func normalizeInput(input Input) (normalizedInput, error) {
	if !invocationPattern.MatchString(input.InvocationID) ||
		!validSourceInboxes(input.SourceInboxIDs) {
		return normalizedInput{}, ErrInvalid
	}
	if input.RequestKind != "room_creation" || input.RoomCaller == nil || input.RoomEffective == nil ||
		validateRoomPair(*input.RoomCaller, *input.RoomEffective) != nil {
		return normalizedInput{}, ErrInvalid
	}
	result := normalizedInput{Input: input, toolName: createRoomTool}
	var err error
	result.callerInputJSON, err = preserveWireJSON(input.CallerInputJSON, input.RoomCaller)
	if err != nil {
		return normalizedInput{}, ErrInvalid
	}
	result.effectiveJSON, err = preserveWireJSON(input.EffectivePayloadJSON, input.RoomEffective)
	if err != nil {
		return normalizedInput{}, ErrInvalid
	}
	result.callerInputHash = sha256.Sum256(result.callerInputJSON)
	return result, nil
}

func validateRoomPair(caller RoomCallerInput, effective RoomEffectivePayload) error {
	if strings.TrimSpace(caller.Name) == "" || utf8.RuneCountInString(caller.Name) > 120 ||
		optionalStringTooLong(caller.Description, 2000) || effective.Name != strings.TrimSpace(caller.Name) ||
		!sameOptionalString(caller.Description, effective.Description) ||
		!validSortedActorIDs(effective.MemberIDs) || !sameStringSet(caller.MemberIDs, effective.MemberIDs) ||
		!validRoomArtifacts(caller.Artifacts) || !validRoomArtifacts(effective.Artifacts) ||
		(caller.Artifacts == nil) != (effective.Artifacts == nil) ||
		!sameStrings(caller.Artifacts, effective.Artifacts) ||
		!equalJSON(caller.InitialMessageSegments, effective.InitialMessageSegments) {
		return ErrInvalid
	}
	if !validCreationSegments(caller.InitialMessageSegments) {
		return ErrInvalid
	}
	_, err := messagecreation.Normalize(effective.InitialMessageSegments)
	return err
}

func validRoomArtifacts(values []string) bool {
	if values == nil {
		return true
	}
	if len(values) < 1 || len(values) > 5 || hasDuplicates(values) {
		return false
	}
	for _, value := range values {
		if !idPattern.MatchString(value) {
			return false
		}
	}
	return true
}

func validSortedActorIDs(values []string) bool {
	if len(values) < 1 || len(values) > 100 {
		return false
	}
	for index, id := range values {
		if !idPattern.MatchString(id) || index > 0 && values[index-1] >= id {
			return false
		}
	}
	return true
}

func sameStringSet(caller, effective []string) bool {
	if len(caller) != len(effective) || hasDuplicates(caller) {
		return false
	}
	copyValues := append([]string(nil), caller...)
	sort.Strings(copyValues)
	return sameStrings(copyValues, effective)
}

func validSourceInboxes(values []string) bool {
	if len(values) > 1024 || hasDuplicates(values) {
		return false
	}
	for _, value := range values {
		// A Room Creation originates in one Room; other Inbox kinds cannot source it.
		if roomID, ok := strings.CutPrefix(value, "room:"); !ok || !idPattern.MatchString(roomID) {
			return false
		}
	}
	return true
}

func deriveSubmissionID(authorization agentauth.Authorization, input normalizedInput) string {
	p := authorization.Principal
	key, _ := json.Marshal([]string{p.TenantID, p.AgentActorID, input.toolName, input.InvocationID})
	digest := sha256.Sum256(key)
	return "agent-operation-" + hex.EncodeToString(digest[:])
}

func mapTypedCardError(err error) error {
	switch {
	case errors.Is(err, typedcard.ErrInvalid):
		return ErrInvalid
	case errors.Is(err, typedcard.ErrNotFound):
		return ErrNotFound
	case errors.Is(err, typedcard.ErrForbidden):
		return ErrForbidden
	case errors.Is(err, typedcard.ErrConflict):
		return ErrConflict
	case errors.Is(err, typedcard.ErrIdempotencyConflict):
		return ErrIdempotencyConflict
	default:
		return err
	}
}

func hasDuplicates(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, found := seen[value]; found {
			return true
		}
		seen[value] = struct{}{}
	}
	return false
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func sameOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func equalJSON(left, right any) bool {
	leftJSON, err := json.Marshal(left)
	if err != nil {
		return false
	}
	rightJSON, err := json.Marshal(right)
	return err == nil && bytes.Equal(leftJSON, rightJSON)
}
