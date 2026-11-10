package collaboration

import (
	"context"
	"encoding/json"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/teammd"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func teamMdParticipantModel(participant teammd.Participant) httpapi.TeamMdParticipant {
	model := httpapi.TeamMdParticipant{
		Name:        participant.Name,
		ActorId:     participant.ActorID,
		ReportTo:    append([]string{}, participant.ReportTo...),
		ReceiveFrom: append([]string{}, participant.ReceiveFrom...),
	}
	if participant.Role != "" {
		role := participant.Role
		model.Role = &role
	}
	return model
}

// RoomTeamMd returns the Room's collaboration protocol document. TeamHub
// owns parsing, so every consumer reads the same structure instead of parsing
// the Markdown again. It reports pgx.ErrNoRows without Room access or a
// document.
func (s *Service) RoomTeamMd(ctx context.Context, accountID, roomID string) (httpapi.TeamMdDocument, error) {
	room, err := s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{
		ID: roomID, AccountID: textValue(accountID),
	})
	if err != nil {
		return httpapi.TeamMdDocument{}, err
	}
	stored, err := s.queries.GetRoomTeamDocument(ctx, store.GetRoomTeamDocumentParams{
		RoomID: roomID, TenantID: room.TenantID,
	})
	if err != nil {
		return httpapi.TeamMdDocument{}, err
	}
	var document teammd.Document
	if err := json.Unmarshal(stored.Document, &document); err != nil {
		return httpapi.TeamMdDocument{}, internal("decode Room team document", err)
	}
	members := make([]httpapi.TeamMdParticipant, 0, len(document.Members))
	for _, member := range document.Members {
		members = append(members, teamMdParticipantModel(member))
	}
	return httpapi.TeamMdDocument{
		CollaboratePattern: httpapi.TeamMdPattern(stored.CollaboratePattern),
		TaskGoal:           document.TaskGoal,
		Orchestrator:       teamMdParticipantModel(document.Orchestrator),
		Members:            members,
		RawMarkdown:        stored.RawMarkdown,
		Revision:           stored.Revision,
		UpdatedAt:          stored.UpdatedAt.Time,
	}, nil
}
