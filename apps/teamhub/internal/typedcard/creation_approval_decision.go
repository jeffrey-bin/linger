package typedcard

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// roomCreationOutcome creates the frozen Room of an approved Room creation,
// or announces its denial, in the decision's transaction. The caller decides
// as the new Room's owner.
func (d *decisionAnswerStep) roomCreationOutcome(ctx context.Context, tx pgx.Tx, queries *store.Queries, answer decisionAnswer) (decisionOutcome, error) {
	owner, err := queries.GetActor(ctx, store.GetActorParams{ID: d.authority.CallerActorID, TenantID: d.authority.TenantID})
	if err != nil {
		return decisionOutcome{}, err
	}
	if answer.Decision == "deny" {
		resultMessage, err := persistDecisionResultMessage(ctx, queries, d.authority.TenantID, d.authority.RoomID,
			d.authority.MessageID, owner, fmt.Sprintf("Collaboration request declined: %s", answer.Comment))
		if err != nil {
			return decisionOutcome{}, err
		}
		return decisionOutcome{messages: []messagecreation.Persisted{resultMessage}}, nil
	}
	var request CreationApprovalSubmission
	if err := json.Unmarshal(d.authority.Request, &request); err != nil {
		return decisionOutcome{}, err
	}
	approval := roomCreationApproval{
		decisionID: d.id, tenantID: d.authority.TenantID, originRoomID: d.authority.RoomID,
		cardMessageID: d.authority.MessageID, agentActorID: d.authority.RequestedByActorID,
		snapshot: request.FulfillmentSnapshot, owner: owner, accountID: d.accountID,
	}
	outcome, createdRoomID, err := approval.approve(ctx, tx, queries)
	if err != nil {
		return decisionOutcome{}, err
	}
	result, err := json.Marshal(decisionStoredResult{Data: json.RawMessage(`{"created_room_id":` + strconv.Quote(createdRoomID) + `}`)})
	if err != nil {
		return decisionOutcome{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE decisions SET result=$2 WHERE id=$1`, d.id, result); err != nil {
		return decisionOutcome{}, err
	}
	return outcome, nil
}

// roomCreationApproval is an approved Room creation.
type roomCreationApproval struct {
	decisionID, tenantID, originRoomID, cardMessageID, agentActorID string
	snapshot                                                        json.RawMessage
	owner                                                           store.Actor
	accountID                                                       string
}

// approve creates the Room with the frozen artifacts its owner may still
// share, posts its initial message and handoff, and reports the result in
// the origin Room. It returns those Messages and the created Room.
func (a roomCreationApproval) approve(ctx context.Context, tx pgx.Tx, queries *store.Queries) (decisionOutcome, string, error) {
	decisionOwner, accountID := a.owner, a.accountID
	var snapshot RoomCreationSnapshot
	if err := json.Unmarshal(a.snapshot, &snapshot); err != nil || snapshot.OriginRoomID != a.originRoomID {
		return decisionOutcome{}, "", ErrConflict
	}
	if _, _, err := roomCreationArtifactReferences(snapshot.Artifacts); err != nil {
		return decisionOutcome{}, "", err
	}
	delivered := make([]RoomCreationArtifactSnapshot, 0, len(snapshot.Artifacts))
	skipped := make([]roomCreationSkippedArtifact, 0)
	// Lock shared Documents in a stable order across simultaneous approvals,
	// while preserving the frozen order in the delivery result and attachments.
	artifactsToReview := append([]RoomCreationArtifactSnapshot(nil), snapshot.Artifacts...)
	sort.Slice(artifactsToReview, func(i, j int) bool { return artifactsToReview[i].DocumentID < artifactsToReview[j].DocumentID })
	reasons := make(map[string]string, len(artifactsToReview))
	reviews := make(map[string]*document.RoomCreationArtifactReview, len(artifactsToReview))
	for _, artifact := range artifactsToReview {
		review, reason, err := document.LockRoomCreationArtifactInTransaction(ctx, tx,
			accountID, a.tenantID, artifact.DocumentID, artifact.DocumentVersionID, artifact.DocumentRevisionID)
		if err != nil {
			return decisionOutcome{}, "", err
		}
		reasons[artifact.DocumentID] = reason
		reviews[artifact.DocumentID] = review
	}
	// Canonical order: the artifact Documents lock after the review's row locks
	// and before the Room creation takes the new members' delivery Accounts.
	artifactDocumentIDs := make([]string, 0, len(artifactsToReview))
	for _, artifact := range artifactsToReview {
		artifactDocumentIDs = append(artifactDocumentIDs, artifact.DocumentID)
	}
	if err := document.Lock(ctx, tx, artifactDocumentIDs); err != nil {
		return decisionOutcome{}, "", err
	}
	agent, err := creationDecisionAgent(ctx, queries, a.tenantID, a.agentActorID)
	if err != nil {
		return decisionOutcome{}, "", err
	}
	created, err := roomcreation.Create(ctx, queries, roomcreation.Spec{
		TenantID: a.tenantID, Name: snapshot.Name, Description: snapshot.Description,
		Creator: agent, Owner: decisionOwner,
		MemberActorIDs:   creationRoomMemberIDs(snapshot.MemberIDs, agent.ID, decisionOwner.ID),
		AgentsAuthorized: true,
	})
	if err != nil {
		return decisionOutcome{}, "", mapCreationDecisionError(err)
	}
	for _, artifact := range artifactsToReview {
		if reasons[artifact.DocumentID] != "" {
			continue
		}
		reason, err := reviews[artifact.DocumentID].BindToRoom(ctx, document.EnsureRoomBindingsInTransactionInput{
			AccountID: accountID, TenantID: a.tenantID, RoomID: created.Room.ID, InitiatedByActorID: decisionOwner.ID,
			IdempotencyKey: "room-create-artifacts:" + a.decisionID, Role: "manager",
		})
		if err != nil {
			return decisionOutcome{}, "", mapCreationDecisionError(err)
		}
		reasons[artifact.DocumentID] = reason
	}
	for _, artifact := range snapshot.Artifacts {
		if reason := reasons[artifact.DocumentID]; reason != "" {
			skipped = append(skipped, roomCreationSkippedArtifact{DocumentID: artifact.DocumentID, Reason: reason})
		} else {
			delivered = append(delivered, artifact)
		}
	}
	_, artifactVersionIDs, err := roomCreationArtifactReferences(delivered)
	if err != nil {
		return decisionOutcome{}, "", err
	}
	content, err := messagecreation.Normalize(roomCreationInitialSegments(snapshot.InitialMessageSegments, skipped))
	if err != nil {
		return decisionOutcome{}, "", ErrConflict
	}
	if _, err := messagecreation.Create(ctx, queries, messagecreation.Draft{
		TenantID: a.tenantID, RoomID: created.Room.ID, Author: agent, Content: content,
		AttachmentVersionIDs: artifactVersionIDs, AttachmentRule: messagecreation.DocumentCardAttachments,
	}); err != nil {
		return decisionOutcome{}, "", mapCreationDecisionError(err)
	}
	// The decision recorded decided_at in this transaction; the handoff carries it.
	var decidedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT decided_at FROM decisions WHERE id=$1`, a.decisionID).Scan(&decidedAt); err != nil {
		return decisionOutcome{}, "", err
	}
	// The handoff shares the initial message's transaction and Room topic, so the
	// requesting Agent's new Room Context accepts both in one batch and wakes once.
	handoff, err := persistRoomCreationHandoffMessage(
		ctx, queries, a.tenantID, created.Room.ID, decisionOwner, agent,
		a.decisionID, a.cardMessageID, a.originRoomID, snapshot.Description, delivered, decidedAt,
	)
	if err != nil {
		return decisionOutcome{}, "", err
	}
	if _, err := messagecreation.Publish(ctx, queries, handoff); err != nil {
		return decisionOutcome{}, "", err
	}
	resultMessage, err := persistDecisionResultMessage(
		ctx, queries, a.tenantID, a.originRoomID, a.cardMessageID,
		decisionOwner, fmt.Sprintf("Collaboration request approved. Room \"%s\" (%s) was created.", snapshot.Name, created.Room.ID),
	)
	if err != nil {
		return decisionOutcome{}, "", err
	}
	runtimeMessage, err := persistCreationApprovalRuntimeMessage(
		ctx, queries, a.tenantID, a.originRoomID, a.cardMessageID,
		decisionOwner, agent, a.decisionID, created.Room.ID, snapshot.Name, delivered, skipped,
	)
	if err != nil {
		return decisionOutcome{}, "", err
	}
	return decisionOutcome{messages: []messagecreation.Persisted{resultMessage, runtimeMessage}}, created.Room.ID, nil
}

func persistCreationApprovalRuntimeMessage(
	ctx context.Context,
	queries *store.Queries,
	tenantID, roomID, cardMessageID string,
	decisionOwner, requestingAgent store.Actor,
	requestID, createdRoomID, createdRoomName string,
	delivered []RoomCreationArtifactSnapshot,
	skipped []roomCreationSkippedArtifact,
) (messagecreation.Persisted, error) {
	summary, err := roomCreationRuntimeSummary(requestID, createdRoomID, createdRoomName, delivered, skipped)
	if err != nil {
		return messagecreation.Persisted{}, err
	}
	return messagecreation.CardHandoff(ctx, queries, messagecreation.Draft{
		TenantID: tenantID, RoomID: roomID, Author: decisionOwner, CardContextMessageID: cardMessageID,
	}, requestingAgent, summary)
}

// persistRoomCreationHandoffMessage hands the approved work to the requesting
// Agent inside the new Room. It carries only request and decision facts and
// delivered Document references: no origin Room messages and no skipped artifacts. The
// approval card stays in the origin Room, so it is referenced by ID instead of
// card_context, which must point within the same Room. The ID is derived from
// the request so the handoff can exist at most once.
func persistRoomCreationHandoffMessage(
	ctx context.Context,
	queries *store.Queries,
	tenantID, roomID string,
	decisionOwner, requestingAgent store.Actor,
	requestID, cardMessageID, originRoomID string,
	description *string,
	delivered []RoomCreationArtifactSnapshot,
	decidedAt time.Time,
) (messagecreation.Persisted, error) {
	text, err := roomCreationHandoffText(
		requestID, cardMessageID, originRoomID, roomID, description, delivered, decisionOwner.ID, decidedAt,
	)
	if err != nil {
		return messagecreation.Persisted{}, err
	}
	return messagecreation.CardHandoff(ctx, queries, messagecreation.Draft{
		ID: roomCreationHandoffMessageID(requestID), TenantID: tenantID, RoomID: roomID, Author: decisionOwner,
	}, requestingAgent, text)
}

func roomCreationHandoffMessageID(requestID string) string {
	digest := sha256.Sum256([]byte("room-creation-handoff:" + requestID))
	return "message_" + hex.EncodeToString(digest[:16])
}

func roomCreationHandoffText(
	requestID, cardMessageID, originRoomID, roomID string,
	description *string,
	delivered []RoomCreationArtifactSnapshot,
	decidedByActorID string,
	decidedAt time.Time,
) (string, error) {
	var purpose *string
	if description != nil {
		if trimmed := strings.TrimSpace(*description); trimmed != "" {
			purpose = &trimmed
		}
	}
	if delivered == nil {
		delivered = []RoomCreationArtifactSnapshot{}
	}
	payload, err := json.Marshal(struct {
		Kind           string                         `json:"kind"`
		RequestID      string                         `json:"creation_approval_request_id"`
		CardMessageID  string                         `json:"approval_card_message_id"`
		OriginRoomID   string                         `json:"origin_room_id"`
		OriginInboxID  string                         `json:"origin_room_inbox_id"`
		RoomInboxID    string                         `json:"room_inbox_id"`
		Purpose        *string                        `json:"purpose,omitempty"`
		DeliveredItems []RoomCreationArtifactSnapshot `json:"delivered_artifacts"`
		Decision       string                         `json:"decision"`
		DecidedBy      string                         `json:"decided_by"`
		DecidedAt      time.Time                      `json:"decided_at"`
	}{
		"room_creation_handoff", requestID, cardMessageID, originRoomID, "room:" + originRoomID, "room:" + roomID,
		purpose, delivered, "approved", decidedByActorID, decidedAt.UTC(),
	})
	if err != nil {
		return "", err
	}
	prompt := fmt.Sprintf(`<room-handoff-pattern>
This Room was created by approval of your request. Continue the requested work here and
reply only to the Inbox room:%s. Origin Room messages are not copied into this Room.
Read delivered_artifacts with teamhub docs get <document-id> and this Room's history with
teamhub message read.
</room-handoff-pattern>`, roomID)
	return " Room creation handoff=" + string(payload) + "\n" + prompt, nil
}

type roomCreationSkippedArtifact struct {
	DocumentID string `json:"document_id"`
	Reason     string `json:"reason"`
}

func roomCreationInitialSegments(segments []messagecreation.Segment, skipped []roomCreationSkippedArtifact) []messagecreation.Segment {
	excluded := make(map[string]bool, len(skipped))
	for _, artifact := range skipped {
		excluded[artifact.DocumentID] = true
	}
	result := make([]messagecreation.Segment, 0, len(segments))
	for _, segment := range segments {
		if segment.Type == "document" && excluded[segment.DocumentID] {
			continue
		}
		result = append(result, segment)
	}
	return result
}

func roomCreationRuntimeSummary(requestID, roomID, roomName string, delivered []RoomCreationArtifactSnapshot, skipped []roomCreationSkippedArtifact) (string, error) {
	type deliveredArtifact struct {
		RoomCreationArtifactSnapshot
		Reason string `json:"reason"`
	}
	deliveryResults := make([]deliveredArtifact, 0, len(delivered))
	for _, artifact := range delivered {
		deliveryResults = append(deliveryResults, deliveredArtifact{artifact, "delivered"})
	}
	if skipped == nil {
		skipped = []roomCreationSkippedArtifact{}
	}
	payload, err := json.Marshal(struct {
		Kind      string                        `json:"kind"`
		RequestID string                        `json:"creation_approval_request_id"`
		Decision  string                        `json:"decision"`
		RoomID    string                        `json:"created_room_id"`
		InboxID   string                        `json:"created_room_inbox_id"`
		Name      string                        `json:"created_room_name"`
		Delivered []deliveredArtifact           `json:"delivered_artifacts"`
		Skipped   []roomCreationSkippedArtifact `json:"skipped_artifacts"`
	}{"room_creation", requestID, "approved", roomID, "room:" + roomID, roomName, deliveryResults, skipped})
	if err != nil {
		return "", err
	}
	prompt := fmt.Sprintf(`<room-communication-pattern>
The new Room has been created. Its Inbox address is room:%s.
Authorized documents have already been delivered with the initial message in the new Room.
This Context cannot send directly to the new Room. Report creation to the user by referencing
its Room link; if Room links are unavailable, quote the created_room_name and created_room_id.
Use delivered_artifacts and skipped_artifacts to report actual document delivery.
</room-communication-pattern>`, roomID)
	return " Room creation approval result=" + string(payload) + "\n" + prompt, nil
}
func creationDecisionAgent(
	ctx context.Context,
	queries *store.Queries,
	tenantID string,
	agentActorID string,
) (store.Actor, error) {
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: agentActorID, TenantID: tenantID})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.Actor{}, ErrConflict
	}
	if err != nil {
		return store.Actor{}, err
	}
	if agent.Kind != "agent" {
		return store.Actor{}, ErrConflict
	}
	return agent, nil
}

func mapCreationDecisionError(err error) error {
	switch {
	case errors.Is(err, roomcreation.ErrInvalid),
		errors.Is(err, roomcreation.ErrNotFound), errors.Is(err, roomcreation.ErrAgentUnavailable),
		errors.Is(err, messagecreation.ErrInvalid), errors.Is(err, messagecreation.ErrInvalidReference),
		errors.Is(err, messagecreation.ErrInvalidDocument), errors.Is(err, document.ErrInvalidInput),
		errors.Is(err, document.ErrNotFound), errors.Is(err, document.ErrVersionConflict):
		return ErrConflict
	default:
		return err
	}
}
