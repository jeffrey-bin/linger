package messagecreation

import (
	"context"
	"errors"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ValidateSkills checks the skill segments of a Message: each names a skill
// of the Agent referenced just before it, and that Agent is an active member of
// roomID with the skill bound at the stated manifest version.
func ValidateSkills(ctx context.Context, queries *store.Queries, tenantID, roomID string, segments []Segment) error {
	references := messageSkillReferences(segments)
	seen := make(map[string]struct{}, len(references))
	targetSet := make(map[string]struct{}, len(references))
	for _, reference := range references {
		if reference.ContextTarget != reference.Target {
			return ErrInvalidSkill
		}
		key := reference.Target + "\x00" + reference.SkillID
		if _, exists := seen[key]; exists {
			return ErrInvalidSkill
		}
		seen[key] = struct{}{}
		targetSet[reference.Target] = struct{}{}
	}
	if len(references) == 0 {
		return nil
	}

	targets := make([]string, 0, len(targetSet))
	for target := range targetSet {
		targets = append(targets, target)
	}
	sort.Strings(targets)
	for _, target := range targets {
		_, err := queries.GetRoomMemberForNoKeyUpdate(ctx, store.GetRoomMemberForNoKeyUpdateParams{
			RoomID: roomID, ActorID: target,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInvalidSkill
		}
		if err != nil {
			return err
		}
	}

	registrations, err := queries.ListAgentSkillRegistrationsForAgents(ctx, targets)
	if err != nil {
		return err
	}
	available := make(map[string]string, len(registrations))
	for _, registration := range registrations {
		available[registration.AgentActorID+"\x00"+registration.SkillID] = registration.ManifestVersion
	}
	for _, reference := range references {
		if available[reference.Target+"\x00"+reference.SkillID] != reference.ManifestVersion {
			return ErrInvalidSkill
		}
	}
	return nil
}
