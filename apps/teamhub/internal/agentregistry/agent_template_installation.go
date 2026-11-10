package agentregistry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// ErrAgentTemplateUnavailable reports a template an Agent creation cannot install.
var ErrAgentTemplateUnavailable = errors.New("Agent template is unavailable")

// Freeze before registering upstream. Recovery must not depend on the template
// still being present in the market or on the browser retaining its dialog.
func reserveAgentTemplateInstallation(ctx context.Context, queries *store.Queries, agentID string, request httpapi.TenantAgentCreateRequest) error {
	templateID := request.TemplateId
	if templateID == nil {
		return nil
	}
	template, err := queries.GetAgentTemplate(ctx, *templateID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrAgentTemplateUnavailable
	}
	if err != nil {
		return err
	}
	var routines []reminder.TemplateRoutine
	if err := json.Unmarshal(template.Routines, &routines); err != nil {
		return err
	}
	if err := reminder.ValidateTemplateRoutines(routines); err != nil {
		return err
	}
	reserved, err := queries.ReserveAgentTemplateInstallation(ctx, store.ReserveAgentTemplateInstallationParams{AgentActorID: agentID, TemplateID: *templateID, Routines: template.Routines})
	if err != nil {
		return err
	}
	if reserved != 1 {
		return fmt.Errorf("reserve template installation for Agent %s: registration missing or already installed", agentID)
	}
	return nil
}

// Activation, direct Room creation, all copies, and command completion commit
// together. The new Agent's lock serializes this with its deletion.
func completeAgentTemplateInstallation(ctx context.Context, tx pgx.Tx, queries *store.Queries, tenantID string, agent, human store.Actor) error {
	installation, err := queries.GetAgentTemplateInstallation(ctx, agent.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if installation.CompletedAt.Valid {
		return nil
	}
	registration, err := queries.GetAgentRegistrationByActor(ctx, store.GetAgentRegistrationByActorParams{TenantID: tenantID, ActorID: agent.ID})
	if err != nil {
		return err
	}
	if registration.Status != "active" || registration.CreatedByActorID != human.ID {
		return collaboration.ErrAgentSponsorRequired
	}
	direct, err := roomcreation.OpenOrCreateDirectRoom(ctx, queries, roomcreation.DirectSpec{
		TenantID: tenantID, Human: human, Agent: agent, Name: agent.DisplayName,
	})
	if err != nil {
		return err
	}
	room := direct.Room
	var routines []reminder.TemplateRoutine
	if err := json.Unmarshal(installation.Routines, &routines); err != nil {
		return err
	}
	if err := reminder.InstallTemplateInTx(ctx, tx, queries, reminder.Authority{TenantID: tenantID, RoomID: room.ID, ActorID: human.ID}, agent.ID, routines); err != nil {
		return err
	}
	return queries.CompleteAgentTemplateInstallation(ctx, agent.ID)
}
