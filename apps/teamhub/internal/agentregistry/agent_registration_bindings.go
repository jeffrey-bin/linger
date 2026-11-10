package agentregistry

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	skillpackage "github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

var (
	// ErrAgentRegistrationManifestNotFound reports a Skill selection whose Manifest the Sponsor cannot bind.
	ErrAgentRegistrationManifestNotFound = errors.New("Agent registration manifest not found")
	// ErrInvalidAgentSkillRegistration reports an invalid initial Skill selection.
	ErrInvalidAgentSkillRegistration = errors.New("invalid Agent Skill registration")
)

// NormalizeAgentRegistrationBindings normalizes the initial Skill selection of an Agent creation request in place.
func NormalizeAgentRegistrationBindings(request *httpapi.TenantAgentCreateRequest) error {
	skills, err := NormalizeAgentSkillRegistrations(pointerSlice(request.SkillBindings))
	if err != nil {
		return err
	}
	request.SkillBindings = &skills
	return nil
}

// Agent registration and Agent template publication accept the same selections,
// so both use this rule. They validate identity and shape only; whether a
// referenced Manifest exists is resolved against the consuming Tenant catalog.
func NormalizeAgentSkillRegistrations(input []httpapi.AgentSkillRegistration) ([]httpapi.AgentSkillRegistration, error) {
	skills := cloneSlice(input)
	if len(skills) > 100 {
		return nil, ErrInvalidAgentSkillRegistration
	}
	seenSkillIDs := map[string]struct{}{}
	for index := range skills {
		skill := &skills[index]
		skill.Name = strings.TrimSpace(skill.Name)
		if skill.Name == "" || len([]rune(skill.Name)) > 120 ||
			!skillIDPattern.MatchString(skill.SkillId) ||
			!SkillManifestVersionPattern.MatchString(skill.ManifestVersion) ||
			contains(seenSkillIDs, skill.SkillId) {
			return nil, ErrInvalidAgentSkillRegistration
		}
		seenSkillIDs[skill.SkillId] = struct{}{}
	}
	sort.Slice(skills, func(left, right int) bool {
		return skills[left].SkillId < skills[right].SkillId
	})
	return skills, nil
}

func storeAgentRegistrationBindings(
	ctx context.Context,
	queries *store.Queries,
	actorID string,
	tenantID string,
	updatedByActorID string,
	request httpapi.TenantAgentCreateRequest,
) error {
	skills := pointerSlice(request.SkillBindings)
	initialConfig := []byte("{}")
	seenSkillRuntimeNames := make(map[string]struct{}, len(skills))
	for _, skill := range skills {
		manifest, err := queries.GetExplicitBindableSkillManifest(ctx, store.GetExplicitBindableSkillManifestParams{
			TenantID: tenantID, SkillID: skill.SkillId, ManifestVersion: skill.ManifestVersion, SponsorActorID: updatedByActorID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrAgentRegistrationManifestNotFound
		}
		if err != nil {
			return err
		}
		if !manifest.CurrentVersion.Bool {
			return ErrSkillManifestNotCurrent
		}
		if manifest.Name != skill.Name || manifest.State != "active" {
			return ErrInvalidAgentSkillRegistration
		}
		if _, duplicate := seenSkillRuntimeNames[manifest.Name]; duplicate {
			return ErrInvalidAgentSkillRegistration
		}
		seenSkillRuntimeNames[manifest.Name] = struct{}{}
		compiled, err := skillpackage.ValidateManifest(manifest.ConfigSchema)
		if err != nil {
			return err
		}
		if err := skillpackage.ValidateConfig(compiled, initialConfig); err != nil {
			return ErrInvalidAgentSkillRegistration
		}
	}
	for _, skill := range skills {
		if _, err := queries.CreateAgentSkillBinding(ctx, store.CreateAgentSkillBindingParams{
			ID: idgen.New("agent_skill_binding"), TenantID: tenantID, AgentActorID: actorID,
			SkillID: skill.SkillId, ManifestVersion: skill.ManifestVersion,
			Enabled: true, Config: initialConfig, BindingVersion: 1,
			UpdatedByActorID: textValue(updatedByActorID),
		}); err != nil {
			return err
		}
	}
	return nil
}

func listAgentRegistrationBindings(
	ctx context.Context,
	queries *store.Queries,
	agentActorIDs []string,
) (map[string][]httpapi.AgentSkillRegistration, error) {
	skillBindings := make(map[string][]httpapi.AgentSkillRegistration, len(agentActorIDs))
	if len(agentActorIDs) == 0 {
		return skillBindings, nil
	}

	skillRows, err := queries.ListAgentSkillRegistrationsForAgents(ctx, agentActorIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range skillRows {
		description := row.Description
		skillBindings[row.AgentActorID] = append(skillBindings[row.AgentActorID], httpapi.AgentSkillRegistration{
			IsDefault: &row.IsDefault,
			Name:      row.Name, SkillId: row.SkillID, ManifestVersion: row.ManifestVersion,
			Description: &description,
		})
	}

	return skillBindings, nil
}

func pointerSlice[T any](value *[]T) []T {
	if value == nil {
		return nil
	}
	return *value
}

func cloneSlice[T any](source []T) []T {
	return append(make([]T, 0, len(source)), source...)
}

func contains(values map[string]struct{}, value string) bool {
	_, exists := values[value]
	return exists
}
