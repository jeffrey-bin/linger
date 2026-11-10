package agentregistry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// Another Me is a template Agent. TeamHub creates it once per Human, in the
// transaction that first records the Human's Computer online with a ready
// Runtime and a writable workspace: the Agent itself, its direct Chat with the
// opening and the profile setup card, and the starter workspace. Until then
// the Human has no Another Me, and nothing waits or polls for the Computer.
// A change to the template reaches existing Another Mes through a migration.
const (
	anotherMeInstructions = `You are Another Me, a private delegate for the Human you represent. Help them organize work, coordinate with other Agents, and act only within explicit TeamHub authority. Never claim to be the Human, never inherit external credentials implicitly, and ask for approval whenever required by product policy.`
	anotherMeGreeting     = "Hi %s, I'm your Another Me — think of me as another you in Linger."
	anotherMeChatName     = "Chat"

	starterResearchAnalystTemplate = "research-analyst"
	starterRoomName                = "Getting Started"
)

// starterWorkspaceTemplates are created in this order; the first one joins the
// starter Room.
var starterWorkspaceTemplates = []string{starterResearchAnalystTemplate, "code-reviewer"}

// EnsureAnotherMe is the Computer online hook and runs on every observation of
// an online Computer; the primary-key read keeps it cheap once the Another Me
// exists. A failure to create the Another Me is logged and leaves the
// observation committed without it, so a broken template never blocks a
// Computer from connecting, and the next heartbeat tries again.
func (s *Service) EnsureAnotherMe(ctx context.Context, tx pgx.Tx, computer agentruntimestate.LocalComputer) error {
	owner := computer.Owner
	_, err := s.queries.WithTx(tx).GetAgentRegistration(ctx, store.GetAgentRegistrationParams{
		ActorID: stableAnotherMeActorID(owner.TenantID, owner.OwnerActorID), TenantID: owner.TenantID,
	})
	if err == nil || !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	if err := s.createAnotherMeTx(ctx, savepoint, computer); err != nil {
		s.logger.Error("another_me.create_failed", "tenant_id", owner.TenantID,
			"human_actor_id", owner.OwnerActorID, "computer_id", computer.ComputerID, "error", err)
		return savepoint.Rollback(ctx)
	}
	return savepoint.Commit(ctx)
}

// createAnotherMeTx creates the Human's Another Me on this Computer, unless
// it already exists or the Computer has no ready Runtime with a writable
// workspace yet.
func (s *Service) createAnotherMeTx(ctx context.Context, tx pgx.Tx, computer agentruntimestate.LocalComputer) error {
	queries := s.queries.WithTx(tx)
	owner := computer.Owner
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "another-me|"+owner.TenantID+"|"+owner.OwnerActorID); err != nil {
		return err
	}
	actorID := stableAnotherMeActorID(owner.TenantID, owner.OwnerActorID)
	_, err := queries.GetAgentRegistration(ctx, store.GetAgentRegistrationParams{ActorID: actorID, TenantID: owner.TenantID})
	if err == nil || !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	human, err := queries.GetActor(ctx, store.GetActorParams{ID: owner.OwnerActorID, TenantID: owner.TenantID})
	if err != nil {
		return err
	}
	if human.Kind != "human" || !human.AccountID.Valid {
		return nil
	}
	row, err := queries.GetAgentRuntimeLocalComputer(ctx, computer.ComputerID)
	if err != nil {
		return err
	}
	now := time.Now()
	if row.LastSeenAt.Valid && row.LastSeenAt.Time.After(now) {
		now = row.LastSeenAt.Time
	}
	projected, listed, err := projectStoredLocalComputer(row, owner.TenantID, now)
	if err != nil || !listed {
		return err
	}
	placement, err := chooseAnotherMeLocalPlacement([]httpapi.LocalComputer{projected})
	if errors.Is(err, errAnotherMeComputerUnavailable) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := queries.AcquireUnifiedSkillPolicyExclusiveLock(ctx); err != nil {
		return err
	}
	registration, err := CreateAgentRegistration(ctx, queries, AgentRegistrationSpec{
		DisplayName: account.AnotherMeName(human.DisplayName),
		CreateAgentRegistrationParams: store.CreateAgentRegistrationParams{
			ActorID: actorID, TenantID: owner.TenantID, AgentManagementID: idgen.New("agent"),
			Description:  account.AnotherMeDescription(human.DisplayName),
			Instructions: anotherMeInstructions, RuntimeModel: placement.Model,
			RuntimeReasoningEffort: textValue(placement.ReasoningEffort),
			ComputerID:             placement.ComputerID,
			LocalRuntimeType:       placement.RuntimeType,
			WorkspaceGrantID:       placement.WorkspaceGrantID,
			CreatedByActorID:       human.ID,
			VisibilityScope:        "sponsor", AgentType: "anotherme",
			RepresentedHumanActorID: textValue(human.ID),
			ReceivesAllMessages:     true,
		},
	})
	if err != nil {
		return err
	}
	if err := skill.ValidateEffectiveInTx(ctx, tx, skill.Identity{
		AgentActorID: registration.ActorID, TenantID: registration.TenantID, AgentType: registration.AgentType,
	}); err != nil {
		return err
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: actorID, TenantID: owner.TenantID})
	if err != nil {
		return err
	}
	chat, err := roomcreation.OpenOrCreateDirectRoom(ctx, queries, roomcreation.DirectSpec{
		TenantID: owner.TenantID, Human: human, Agent: agent, Name: anotherMeChatName,
	})
	if err != nil {
		return err
	}
	if err := collaboration.PostAgentOpening(ctx, queries, owner.TenantID, chat.Room.ID, human, agent,
		fmt.Sprintf(anotherMeGreeting, collaboration.GreetingName(human.DisplayName)), typedcard.ProfileSetupAppsOpening()); err != nil {
		return err
	}
	if err := createTenantAgentDirectoryDeliveries(ctx, queries, owner.TenantID); err != nil {
		return err
	}
	if err := createTenantAnotherMeDeliveries(ctx, queries, owner.TenantID); err != nil {
		return err
	}
	return s.createStarterWorkspaceTx(ctx, tx, human, registration)
}

// createStarterWorkspaceTx gives the Human the starter template Agents on the
// Another Me's placement and one group Room with their Another Me and the
// Research Analyst. A starter Agent that its template, Skills, placement or
// the Agent limit rule out is logged and skipped, so the others and the
// Another Me are still created; any other error fails the whole creation,
// which the next heartbeat retries.
func (s *Service) createStarterWorkspaceTx(ctx context.Context, tx pgx.Tx, human store.Actor, anotherMe store.AgentRegistration) error {
	var researchAnalystID string
	for _, templateID := range starterWorkspaceTemplates {
		actorID, err := s.createStarterAgentTx(ctx, tx, human, anotherMe, templateID)
		if err != nil {
			return err
		}
		if templateID == starterResearchAnalystTemplate {
			researchAnalystID = actorID
		}
	}
	if researchAnalystID == "" {
		return nil
	}
	_, err := roomcreation.Create(ctx, s.queries.WithTx(tx), roomcreation.Spec{
		TenantID: human.TenantID, Name: starterRoomName, Creator: human, Owner: human,
		MemberActorIDs: []string{anotherMe.ActorID, researchAnalystID},
	})
	return err
}

// createStarterAgentTx creates one starter Agent in its own savepoint and
// returns its Actor ID, or "" when it was skipped.
func (s *Service) createStarterAgentTx(ctx context.Context, tx pgx.Tx, human store.Actor, anotherMe store.AgentRegistration, templateID string) (string, error) {
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return "", err
	}
	actorID, err := s.insertStarterAgent(ctx, savepoint, s.queries.WithTx(savepoint), human, anotherMe, templateID)
	switch {
	case errors.Is(err, ErrAgentTemplateUnavailable), errors.Is(err, ErrAgentPlacementTargetUnavailable),
		errors.Is(err, ErrAgentRegistrationManifestNotFound), errors.Is(err, ErrSkillManifestNotCurrent),
		errors.Is(err, ErrInvalidAgentSkillRegistration), errors.Is(err, ErrAgentLimitReached):
		s.logger.Error("another_me.starter_agent_skipped", "tenant_id", human.TenantID,
			"human_actor_id", human.ID, "template_id", templateID, "error", err)
		return "", savepoint.Rollback(ctx)
	case err != nil:
		_ = savepoint.Rollback(ctx)
		return "", err
	}
	return actorID, savepoint.Commit(ctx)
}

// insertStarterAgent creates one template Agent on the Another Me's placement
// and returns its Actor ID, or "" when the template is not installed.
func (s *Service) insertStarterAgent(ctx context.Context, tx pgx.Tx, queries *store.Queries, human store.Actor, anotherMe store.AgentRegistration, templateID string) (string, error) {
	template, err := queries.GetAgentTemplate(ctx, templateID)
	if errors.Is(err, pgx.ErrNoRows) {
		s.logger.Warn("another_me.starter_template_missing", "tenant_id", human.TenantID, "template_id", templateID)
		return "", nil
	}
	if err != nil {
		return "", err
	}
	bindings, err := currentStarterSkillBindings(ctx, queries, human.TenantID, human.ID, template.SkillBindings)
	if err != nil {
		return "", err
	}
	agentType := httpapi.CreatableAgentTypeGeneral
	visibility := httpapi.AgentVisibilityScopeSponsor
	description := strings.TrimSpace(template.Description)
	runtime := agentRuntimeConfig(anotherMe)
	runtime.Model = strings.TrimSpace(runtime.Model)
	request := httpapi.TenantAgentCreateRequest{
		AgentType: &agentType, VisibilityScope: &visibility, TemplateId: &templateID,
		Name: strings.TrimSpace(template.Name), Description: &description,
		Instructions: strings.TrimSpace(template.Instructions),
		Runtime:      runtime, SkillBindings: &bindings,
	}
	if template.AvatarKey.Valid {
		request.AvatarKey = &template.AvatarKey.String
	}
	if err := NormalizeAgentRegistrationBindings(&request); err != nil {
		return "", err
	}
	actorID, _, err := insertTenantAgent(ctx, tx, queries, human.TenantID, human.ID, request)
	return actorID, err
}

// currentStarterSkillBindings binds each template Skill at its current latest
// active version, since platform Skills accept only that version. A Skill the
// Human cannot bind is left out.
func currentStarterSkillBindings(ctx context.Context, queries *store.Queries, tenantID, humanActorID string, encoded []byte) ([]httpapi.AgentSkillRegistration, error) {
	var bindings []httpapi.AgentSkillRegistration
	if err := json.Unmarshal(encoded, &bindings); err != nil {
		return nil, err
	}
	current := make([]httpapi.AgentSkillRegistration, 0, len(bindings))
	for _, binding := range bindings {
		rows, err := queries.ListBindableSkillManifests(ctx, store.ListBindableSkillManifestsParams{
			CallerActorID: humanActorID, TenantID: tenantID,
			CursorSkillID: binding.SkillId, PageLimit: 100,
		})
		if err != nil {
			return nil, err
		}
		// A platform Skill lists only its current version.
		var latest *store.ListBindableSkillManifestsRow
		for index := range rows {
			if rows[index].SkillID == binding.SkillId && rows[index].Availability == "active" {
				latest = &rows[index]
			}
		}
		if latest == nil {
			continue
		}
		current = append(current, httpapi.AgentSkillRegistration{
			Name: latest.Name, SkillId: latest.SkillID, ManifestVersion: latest.ManifestVersion,
		})
	}
	return current, nil
}

// AnotherMe returns the Human's Another Me and its Chat. Both are absent
// until the Human's Computer first comes online with a ready Runtime;
// pgx.ErrNoRows reports a Human that is not in the Space.
func (s *Service) AnotherMe(ctx context.Context, accountID, tenantID string) (httpapi.AnotherMe, error) {
	human, err := s.queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: tenantID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.AnotherMe{}, err
	}
	chat, err := s.queries.GetAnotherMeChat(ctx, store.GetAnotherMeChatParams{TenantID: tenantID, HumanActorID: human.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpapi.AnotherMe{}, nil
	}
	if err != nil {
		return httpapi.AnotherMe{}, err
	}
	model := httpapi.AnotherMe{AgentActorId: &chat.AgentActorID}
	if chat.RoomID.Valid {
		model.RoomId = &chat.RoomID.String
	}
	return model, nil
}

func stableAnotherMeActorID(tenantID, humanActorID string) string {
	digest := sha256.Sum256([]byte("another-me-actor\x00" + tenantID + "\x00" + humanActorID))
	return "actor_anotherme_" + hex.EncodeToString(digest[:16])
}
