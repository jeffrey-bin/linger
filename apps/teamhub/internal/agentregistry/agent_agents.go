package agentregistry

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
	"golang.org/x/text/unicode/norm"
)

const (
	// AgentRequestMaxBytes bounds an Agent command body.
	AgentRequestMaxBytes = 256 << 10
	// MaxSponsorGeneralAgents caps the General Agents of one Sponsor.
	MaxSponsorGeneralAgents = 50
)

var (
	// ErrAgentLimitReached reports a Sponsor that already has MaxSponsorGeneralAgents Agents.
	ErrAgentLimitReached = errors.New("Sponsor already has the maximum number of Agents")
	// ErrSponsorNotRoomMember reports a caller's Room its Sponsor is not in,
	// so nobody can admit a member on the Sponsor's behalf.
	ErrSponsorNotRoomMember = errors.New("Sponsor is not a member of the Room")
	// AgentInvocationPattern matches an Agent command invocation ID.
	AgentInvocationPattern = regexp.MustCompile(`^agent-invocation-sha256:[a-f0-9]{64}$`)
)

// sponsorAgent is a target the caller may read or change: an active General
// Agent of the caller's Sponsor, locked for the transaction.
type sponsorAgent struct {
	registration store.GetAgentRegistrationForUpdateRow
	name         string
}

func lockSponsorAgent(ctx context.Context, queries *store.Queries, tenantID, sponsorActorID, actorID string) (sponsorAgent, error) {
	row, err := queries.GetAgentRegistrationForUpdate(ctx, store.GetAgentRegistrationForUpdateParams{
		ActorID: actorID, TenantID: tenantID,
	})
	if err != nil {
		return sponsorAgent{}, err
	}
	if row.Status != "active" || row.AgentType != "general" || row.CreatedByActorID != sponsorActorID {
		return sponsorAgent{}, collaboration.ErrAgentSponsorRequired
	}
	actor, err := queries.GetActor(ctx, store.GetActorParams{ID: actorID, TenantID: tenantID})
	if err != nil {
		return sponsorAgent{}, err
	}
	return sponsorAgent{registration: row, name: actor.DisplayName}, nil
}

func sponsorAccountID(ctx context.Context, queries *store.Queries, auth agentauth.Authorization) (string, error) {
	sponsor, err := queries.GetActor(ctx, store.GetActorParams{ID: auth.SponsorActorID, TenantID: auth.TenantID})
	if err != nil {
		return "", err
	}
	if sponsor.Kind != "human" || !sponsor.AccountID.Valid || sponsor.AccountID.String == "" {
		return "", collaboration.ErrAgentSponsorRequired
	}
	return sponsor.AccountID.String, nil
}

// lockAgentProfileTarget serializes profile changes of one Agent. Take it
// before authorization share-locks the caller's registration: two concurrent
// changes of the same Agent would otherwise deadlock upgrading those locks.
func lockAgentProfileTarget(ctx context.Context, queries *store.Queries, tenantID, actorID string) error {
	return queries.AcquireAdvisoryTransactionLock(ctx, "agent-profile:"+tenantID+":"+actorID)
}

// NormalizedAgentText trims and NFC-normalizes an optional profile field.
func NormalizedAgentText(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := norm.NFC.String(strings.TrimSpace(*value))
	return &normalized
}

// ValidAgentProfileChange enforces the contract limits on provided fields.
func ValidAgentProfileChange(change AgentProfileChange) bool {
	if change.Name != nil && (*change.Name == "" || utf8.RuneCountInString(*change.Name) > 120 || !utf8.ValidString(*change.Name)) {
		return false
	}
	if change.Description != nil && (utf8.RuneCountInString(*change.Description) > 1000 || !utf8.ValidString(*change.Description)) {
		return false
	}
	if change.Instructions != nil && (*change.Instructions == "" || utf8.RuneCountInString(*change.Instructions) > 50000 ||
		!utf8.ValidString(*change.Instructions) || collaboration.IsUninitializedAgentProfile(*change.Instructions)) {
		return false
	}
	return true
}

// CreateSponsorAgent registers a General Agent of the Sponsor with the
// caller's Runtime, exactly like a Web creation. key makes it idempotent.
func (s *Service) CreateSponsorAgent(ctx context.Context, accountID, tenantID, callerActorID string, change AgentProfileChange, key string) (string, error) {
	caller, err := s.queries.GetAgentRegistrationByActor(ctx, store.GetAgentRegistrationByActorParams{
		ActorID: callerActorID, TenantID: tenantID,
	})
	if err != nil {
		return "", err
	}
	if caller.Status != "active" {
		return "", collaboration.ErrAgentSponsorRequired
	}
	agentType, visibility := httpapi.CreatableAgentTypeGeneral, httpapi.AgentVisibilityScopeSponsor
	result, err := s.ExecuteTenantAgentRegistration(ctx, accountID, tenantID, httpapi.TenantAgentCreateRequest{
		Name: *change.Name, Description: change.Description, Instructions: *change.Instructions,
		Runtime: agentRuntimeConfig(agentRegistrationFromRow(caller)), AgentType: &agentType, VisibilityScope: &visibility,
	}, key)
	if err != nil {
		return "", err
	}
	var created httpapi.TenantAgent
	if err := json.Unmarshal(result.Body, &created); err != nil {
		return "", err
	}
	if created.Actor.Id == "" {
		return "", errors.New("created Agent has no Actor")
	}
	return created.Actor.Id, nil
}

// AgentChangeRequest is the stored change a decision runs.
type AgentChangeRequest struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
	Prompt      *string `json:"prompt,omitempty"`
}

func agentChangeRequestOf(change AgentProfileChange) AgentChangeRequest {
	return AgentChangeRequest{Name: change.Name, Description: change.Description, Prompt: change.Instructions}
}

// Change is the profile change the stored request names.
func (request AgentChangeRequest) Change() AgentProfileChange {
	return AgentProfileChange{Name: request.Name, Description: request.Description, Instructions: request.Prompt}
}

func agentCreateCard(change AgentProfileChange) typedcard.AgentChangeView {
	card := typedcard.AgentChangeView{Action: "create", AgentName: *change.Name}
	card.Changes = append(card.Changes, typedcard.AgentChange{Field: "name", After: *change.Name})
	if *change.Description != "" {
		card.Changes = append(card.Changes, typedcard.AgentChange{Field: "description", After: *change.Description})
	}
	card.Changes = append(card.Changes, typedcard.AgentChange{Field: "prompt", After: *change.Instructions})
	return card
}

func agentUpdateCard(target sponsorAgent, change AgentProfileChange) typedcard.AgentChangeView {
	card := typedcard.AgentChangeView{
		Action: "update", TargetActorID: target.registration.ActorID, AgentName: target.name,
	}
	add := func(field string, before string, after *string) {
		if after != nil {
			card.Changes = append(card.Changes, typedcard.AgentChange{Field: field, Before: &before, After: *after})
		}
	}
	add("name", target.name, change.Name)
	add("description", target.registration.Description, change.Description)
	add("prompt", target.registration.Instructions, change.Instructions)
	return card
}

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}
