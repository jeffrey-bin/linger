package document

import (
	"context"
	"errors"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomattention"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/tenantmembership"
)

type commentChange struct {
	Kind       string
	TenantID   string
	RoomID     string
	DocumentID string
	ThreadID   string
	CommentID  string
	// VersionNumber is the comment's edit number after this change.
	VersionNumber int64
	AnchorID      string
	ActorID       string
	ActorKind     string
	DurableHead   *DurableHeadSelector
}

type mentionPrincipal struct {
	Kind string
	ID   string
}

func prepareHumanAgentMentionReferences(
	ctx context.Context,
	queries *store.Queries,
	documentID string,
	currentContext *CurrentContextSelector,
	principal mentionPrincipal,
	referenceActorIDs []string,
) ([]store.ListCurrentRoomDocumentCommentReferenceActorsRow, error) {
	if len(referenceActorIDs) == 0 {
		return []store.ListCurrentRoomDocumentCommentReferenceActorsRow{}, nil
	}
	referenceActors := make([]store.ListCurrentRoomDocumentCommentReferenceActorsRow, 0, len(referenceActorIDs))
	switch principal.Kind {
	case "human":
		// A Human comment references only Agents, which it wakes.
		seen := make(map[string]struct{}, len(referenceActorIDs))
		appendActor := func(actor store.ListCurrentRoomDocumentCommentReferenceActorsRow) {
			if _, exists := seen[actor.ID]; exists {
				return
			}
			seen[actor.ID] = struct{}{}
			referenceActors = append(referenceActors, actor)
		}
		// Current Document authorization is enough to @ a discoverable Agent
		// from a Room comment. Do not require Room membership.
		agents, err := queries.ListCurrentDocumentCommentAgentReferenceActorsForHuman(ctx,
			store.ListCurrentDocumentCommentAgentReferenceActorsForHumanParams{
				AccountID: principal.ID, DocumentID: documentID, ActorIds: referenceActorIDs,
			})
		if err != nil {
			return nil, err
		}
		for _, actor := range agents {
			appendActor(store.ListCurrentRoomDocumentCommentReferenceActorsRow(actor))
		}
		if len(referenceActors) < len(referenceActorIDs) && currentContext != nil &&
			currentContext.BindingKind == "room" && currentContext.ContextID != "" {
			roomActors, err := queries.ListCurrentDocumentCommentRoomReferenceActorsForHuman(ctx,
				store.ListCurrentDocumentCommentRoomReferenceActorsForHumanParams{
					AccountID: principal.ID, DocumentID: documentID,
					RoomID: currentContext.ContextID, ActorIds: referenceActorIDs,
				})
			if err != nil {
				return nil, err
			}
			for _, actor := range roomActors {
				if actor.Kind == "agent" {
					appendActor(store.ListCurrentRoomDocumentCommentReferenceActorsRow(actor))
				}
			}
		}
	case "agent":
		// An Agent reply carries no Room context; it may name the Space's
		// Human, which is only displayed.
		humans, err := queries.ListCurrentDocumentCommentHumanReferenceActorsForAgent(ctx,
			store.ListCurrentDocumentCommentHumanReferenceActorsForAgentParams{
				AgentManagementID: principal.ID, DocumentID: documentID, ActorIds: referenceActorIDs,
			})
		if err != nil {
			return nil, err
		}
		for _, actor := range humans {
			referenceActors = append(referenceActors, store.ListCurrentRoomDocumentCommentReferenceActorsRow(actor))
		}
	default:
		return nil, ErrCommentInvalidInput
	}
	if len(referenceActors) != len(referenceActorIDs) {
		return nil, ErrCommentInvalidInput
	}
	sort.Slice(referenceActors, func(left, right int) bool { return referenceActors[left].ID < referenceActors[right].ID })
	agentIDs := make([]string, 0, len(referenceActors))
	for _, actor := range referenceActors {
		if actor.Kind == "agent" {
			agentIDs = append(agentIDs, actor.ID)
		}
	}
	if len(agentIDs) == 0 {
		return referenceActors, nil
	}
	if err := tenantmembership.LockAgents(ctx, queries, agentIDs...); err != nil {
		return nil, err
	}
	if err := AcquireGenerationLock(ctx, queries, documentID); err != nil {
		return nil, err
	}
	return referenceActors, nil
}

func mentionRoomID(currentContext *CurrentContextSelector, _ []string) string {
	if currentContext == nil || currentContext.BindingKind != "room" {
		return ""
	}
	return currentContext.ContextID
}

func recordCommentChange(
	ctx context.Context,
	tx pgx.Tx,
	queries *store.Queries,
	change commentChange,
	referenceActors []store.ListCurrentRoomDocumentCommentReferenceActorsRow,
) error {
	// Canonical order: the Room sequence row, then the Document.
	if change.RoomID != "" {
		if err := queries.LockTenantDeliveryRooms(ctx, store.LockTenantDeliveryRoomsParams{
			TenantID: change.TenantID, RoomIds: []string{change.RoomID},
		}); err != nil {
			return err
		}
	}
	if err := Lock(ctx, tx, []string{change.DocumentID}); err != nil {
		return err
	}
	if err := recordUnifiedDocumentCommentEvent(ctx, tx, change); err != nil {
		return err
	}
	if change.RoomID == "" {
		return invokeMentionedAgents(ctx, tx, queries, change, referenceActors)
	}
	attention, err := newlyMentionedHumans(ctx, queries, change.CommentID, referenceActors)
	if err != nil {
		return err
	}
	payload := map[string]any{
		"kind": "document.comment.changed", "change_kind": change.Kind,
		"document_id": change.DocumentID, "thread_id": change.ThreadID,
	}
	if change.CommentID != "" {
		payload["comment_id"] = change.CommentID
	}
	if len(attention) > 0 {
		// The Room list counts this event as an unread @ for these Humans.
		payload["attention_actor_ids"] = attention
	}
	roomSeq, err := roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: change.TenantID, RoomID: change.RoomID, EventType: "document.comment.changed",
		ActorID: change.ActorID, ResourceID: change.ThreadID,
		Payload: payload,
	})
	if err != nil {
		return err
	}
	if change.ActorKind == "human" {
		if _, err := queries.AdvanceRoomMemberReadState(ctx, store.AdvanceRoomMemberReadStateParams{
			RoomID: change.RoomID, ActorID: change.ActorID, ReadThroughRoomSeq: roomSeq,
		}); err != nil {
			return err
		}
	}
	if err := invokeMentionedAgents(ctx, tx, queries, change, referenceActors); err != nil {
		return err
	}
	if len(attention) == 0 {
		return nil
	}
	return roomattention.AppendForTenantHumans(ctx, queries, roomattention.RoomSummaryUpdate{
		TenantID: change.TenantID, RoomID: change.RoomID, RoomSeq: roomSeq, Reason: "document.comment.mentioned",
	})
}

// newlyMentionedHumans returns the Humans an Agent reply names that this
// comment has not brought to Room attention before, so removing and re-adding
// a mention does not count twice. Human comments reference only Agents.
func newlyMentionedHumans(
	ctx context.Context,
	queries *store.Queries,
	commentID string,
	referenceActors []store.ListCurrentRoomDocumentCommentReferenceActorsRow,
) ([]string, error) {
	humanIDs := make([]string, 0, len(referenceActors))
	for _, actor := range referenceActors {
		if actor.Kind == "human" {
			humanIDs = append(humanIDs, actor.ID)
		}
	}
	if len(humanIDs) == 0 {
		return nil, nil
	}
	attended, err := queries.ListDocumentCommentAttentionActors(ctx, store.ListDocumentCommentAttentionActorsParams{
		CommentID: commentID, ActorIds: humanIDs,
	})
	if err != nil {
		return nil, err
	}
	skip := make(map[string]struct{}, len(attended))
	for _, actorID := range attended {
		skip[actorID] = struct{}{}
	}
	attention := make([]string, 0, len(humanIDs))
	for _, actorID := range humanIDs {
		if _, done := skip[actorID]; !done {
			attention = append(attention, actorID)
		}
	}
	return attention, nil
}

func recordUnifiedDocumentCommentEvent(ctx context.Context, tx pgx.Tx, change commentChange) error {
	_, err := tx.Exec(ctx, `INSERT INTO document_events(
			id,tenant_id,document_id,event_type,actor_id,resource_kind,resource_id,projection_version
		)
		SELECT $1,$2,$3,'document.comment_updated',$4,'comment_thread',$5,1
		FROM documents document
		WHERE document.id=$3 AND document.tenant_id=$2`,
		newCommentID("document_event_"), change.TenantID, change.DocumentID, change.ActorID, change.ThreadID)
	return err
}

// invokeMentionedAgents queues one Run for each Agent a Human's comment
// mentions. An Agent this comment already invoked is skipped, so editing the
// comment does not invoke it again; a unique key on the Runtime input enforces
// the same rule.
func invokeMentionedAgents(
	ctx context.Context,
	tx pgx.Tx,
	queries *store.Queries,
	change commentChange,
	referenceActors []store.ListCurrentRoomDocumentCommentReferenceActorsRow,
) error {
	if change.ActorKind != "human" {
		return nil
	}
	agentIDs := make([]string, 0, len(referenceActors))
	for _, actor := range referenceActors {
		if actor.Kind == "agent" {
			agentIDs = append(agentIDs, actor.ID)
		}
	}
	if len(agentIDs) == 0 {
		return nil
	}
	if change.DurableHead == nil || change.AnchorID == "" {
		return ErrCommentInvalidInput
	}
	invoked, err := queries.ListDocumentCommentInvokedAgents(ctx, store.ListDocumentCommentInvokedAgentsParams{
		DocumentID: change.DocumentID, CommentID: change.CommentID, ActorIds: agentIDs,
	})
	if err != nil {
		return err
	}
	skip := make(map[string]struct{}, len(invoked))
	for _, agentID := range invoked {
		skip[agentID] = struct{}{}
	}
	for _, agentID := range agentIDs {
		if _, done := skip[agentID]; done {
			continue
		}
		err := CreateForMention(ctx, tx, MentionInput{
			TenantID: change.TenantID, RoomID: change.RoomID, DocumentID: change.DocumentID,
			ThreadID: change.ThreadID, CommentID: change.CommentID,
			CommentVersion: change.VersionNumber,
			AgentActorID:   agentID,
			Head: HeadSelector{
				PersistedSeq:     change.DurableHead.PersistedSeq,
				StateHash:        change.DurableHead.StateHash,
				StateHashVersion: change.DurableHead.StateHashVersion,
			},
		})
		if errors.Is(err, ErrStaleHead) {
			return ErrCommentConflict
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func referenceActorsFromIDs(
	ctx context.Context,
	queries *store.Queries,
	tenantID, roomID string,
	actorIDs []string,
) ([]store.ListCurrentRoomDocumentCommentReferenceActorsRow, error) {
	if len(actorIDs) == 0 {
		return []store.ListCurrentRoomDocumentCommentReferenceActorsRow{}, nil
	}
	actors, err := queries.ListCurrentRoomDocumentCommentReferenceActors(ctx, store.ListCurrentRoomDocumentCommentReferenceActorsParams{
		RoomID: roomID, TenantID: tenantID, ActorIds: actorIDs,
	})
	if err != nil {
		return nil, err
	}
	if len(actors) != len(actorIDs) {
		return nil, ErrCommentInvalidInput
	}
	return actors, nil
}
