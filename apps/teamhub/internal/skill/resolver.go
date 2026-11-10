// The resolver computes an Agent's effective Skill set: its Agent Type
// defaults plus its enabled explicit bindings.

package skill

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

const maxSkills = 100

var (
	ErrInvalid    = errors.New("invalid Skill Context request")
	ErrConflict   = errors.New("Skill Context has conflicting Skills")
	ErrDependency = errors.New("Skill Context dependency is unavailable")
)

type Identity struct {
	AgentID      string
	AgentActorID string
	TenantID     string
	AgentType    string
}

type Item struct {
	SkillID         string
	ManifestID      string
	ManifestVersion string
	Name            string
	PackageSHA256   string
	Source          string
	Config          map[string]any
	configSchema    []byte
}

// ResolveEffectiveInTx reads current Agent policy without creating a Context,
// generation, or access credential. Callers own a consistent read Tx.
func ResolveEffectiveInTx(ctx context.Context, tx pgx.Tx, identity Identity) ([]Item, string, error) {
	if tx == nil || !validIdentity(identity) {
		return nil, "", ErrInvalid
	}
	items, err := resolveEffectiveItems(ctx, tx, identity)
	if err != nil {
		return nil, "", err
	}
	digest, err := effectiveDigest(items)
	if err != nil {
		return nil, "", err
	}
	return items, hex.EncodeToString(digest), nil
}

// ValidateEffectiveInTx applies the same policy as ResolveEffectiveInTx. Write
// paths call it before committing a registration or binding change, while
// Context activation resolves the set again.
func ValidateEffectiveInTx(ctx context.Context, tx pgx.Tx, identity Identity) error {
	if tx == nil || !validPolicyIdentity(identity) {
		return ErrInvalid
	}
	_, err := resolveEffectiveItems(ctx, tx, identity)
	return err
}

// HasEffectiveSkillInTx checks the same default and explicit Skill policy
// that Context activation will resolve, without creating a Context generation.
// It matches the Skill identity, so any effective version of the Skill counts.
func HasEffectiveSkillInTx(ctx context.Context, tx pgx.Tx, identity Identity, skillID string) (bool, error) {
	if tx == nil || !validPolicyIdentity(identity) || skillID == "" {
		return false, ErrInvalid
	}
	items, err := resolveEffectiveItems(ctx, tx, identity)
	if err != nil {
		return false, err
	}
	for _, item := range items {
		if item.SkillID == skillID {
			return true, nil
		}
	}
	return false, nil
}

// ValidateDefaultBaselineInTx validates the final default-only policy for an
// Agent Type, including types that do not have a persisted Agent yet.
func ValidateDefaultBaselineInTx(ctx context.Context, tx pgx.Tx, agentType string) error {
	if tx == nil || !validAgentType(agentType) {
		return ErrInvalid
	}
	items, err := queryDefaultItems(ctx, tx, agentType)
	if err != nil {
		return err
	}
	_, err = validateResolvedItems(items)
	return err
}

func resolveEffectiveItems(ctx context.Context, tx pgx.Tx, identity Identity) ([]Item, error) {
	defaults, err := queryDefaultItems(ctx, tx, identity.AgentType)
	if err != nil {
		return nil, err
	}
	// Every enabled binding must resolve; one that no longer does needs repair
	// rather than silently dropping out of the effective set.
	explicit, err := queryItems(ctx, tx, `
		SELECT binding.skill_id,COALESCE(manifest.manifest_id,''),binding.manifest_version,
		       COALESCE(skill.name,''),COALESCE(encode(manifest.content_hash,'hex'),''),'explicit'::text,
		       binding.config,COALESCE(manifest.config_schema,'{}'::jsonb),
		       CASE
		           WHEN cardinality(skill.default_agent_types)>0
		               THEN binding.id || ': explicit binding selects a default-only Skill'
		           WHEN skill.skill_id IS NULL
		                OR NOT (skill.owner_kind='platform' OR skill.tenant_id=$2)
		                OR manifest.package_state IS DISTINCT FROM 'sealed'
		                OR manifest.state IS DISTINCT FROM 'active'
		               THEN binding.id || ': binding references an unavailable Skill'
		           ELSE ''
		       END
		FROM agent_skill_bindings binding
		LEFT JOIN skills skill ON skill.skill_id=binding.skill_id
		LEFT JOIN skill_manifests manifest
		  ON manifest.skill_id=binding.skill_id
		 AND manifest.manifest_version=binding.manifest_version
		WHERE binding.agent_actor_id=$1 AND binding.tenant_id=$2
		  AND binding.enabled AND binding.deleted_at IS NULL
		ORDER BY binding.skill_id COLLATE "C"`, identity.AgentActorID, identity.TenantID)
	if err != nil {
		return nil, err
	}
	return validateResolvedItems(append(defaults, explicit...))
}

// queryDefaultItems reads the latest Manifest of every Platform Skill that is
// a default for agentType; a default without an active sealed latest Manifest
// needs repair.
func queryDefaultItems(ctx context.Context, tx pgx.Tx, agentType string) ([]Item, error) {
	return queryItems(ctx, tx, `
		SELECT skill.skill_id,COALESCE(manifest.manifest_id,''),COALESCE(manifest.manifest_version,''),
		       skill.name,COALESCE(encode(manifest.content_hash,'hex'),''),'default'::text,
		       '{}'::jsonb,COALESCE(manifest.config_schema,'{}'::jsonb),
		       CASE
		           WHEN skill.owner_kind<>'platform'
		                OR manifest.package_state IS DISTINCT FROM 'sealed'
		                OR manifest.state IS DISTINCT FROM 'active'
		               THEN skill.skill_id || ': unavailable default Skill'
		           ELSE ''
		       END
		FROM skills skill
		LEFT JOIN skill_manifests manifest
		  ON manifest.manifest_id=skill.latest_manifest_id
		 AND manifest.skill_id=skill.skill_id
		WHERE $1=ANY(skill.default_agent_types)
		ORDER BY skill.skill_id COLLATE "C"`, agentType)
}

func validateResolvedItems(candidates []Item) ([]Item, error) {
	items := make([]Item, 0, len(candidates))
	seenIDs := make(map[string]string, len(candidates))
	seenNames := make(map[string]string, len(candidates))
	for _, item := range candidates {
		if _, exists := seenIDs[item.SkillID]; exists {
			return nil, newPolicyConflict("duplicate Skill selection", item.SkillID)
		}
		foldedName := strings.ToLower(item.Name)
		if previous, exists := seenNames[foldedName]; exists {
			return nil, newPolicyConflict("Skills share a Runtime name", previous, item.SkillID)
		}
		seenIDs[item.SkillID] = item.Source
		seenNames[foldedName] = item.SkillID
		items = append(items, item)
	}
	if len(items) > maxSkills {
		return nil, newPolicyConflict(fmt.Sprintf("effective Skill count %d exceeds %d", len(items), maxSkills))
	}
	sort.Slice(items, func(left, right int) bool { return items[left].SkillID < items[right].SkillID })
	return items, nil
}

func queryItems(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]Item, error) {
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []Item
	var unavailable []string
	for rows.Next() {
		var item Item
		var rawConfig []byte
		var problem string
		if err := rows.Scan(
			&item.SkillID, &item.ManifestID, &item.ManifestVersion, &item.Name,
			&item.PackageSHA256, &item.Source, &rawConfig, &item.configSchema, &problem,
		); err != nil {
			return nil, err
		}
		if problem != "" {
			unavailable = append(unavailable, problem)
			continue
		}
		if err := json.Unmarshal(rawConfig, &item.Config); err != nil || item.Config == nil {
			return nil, newPolicyConflict("invalid Skill configuration", item.SkillID)
		}
		compiled, err := ValidateManifest(item.configSchema)
		if err != nil || ValidateConfig(compiled, rawConfig) != nil {
			return nil, newPolicyConflict("invalid Skill configuration", item.SkillID)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(unavailable) > 0 {
		return nil, newPolicyConflict("invalid Skill references", unavailable...)
	}
	return items, nil
}

func effectiveDigest(items []Item) ([]byte, error) {
	type digestItem struct {
		SkillID         string         `json:"skill_id"`
		ManifestID      string         `json:"manifest_id"`
		ManifestVersion string         `json:"manifest_version"`
		Name            string         `json:"name"`
		PackageSHA256   string         `json:"package_sha256"`
		Source          string         `json:"source"`
		Config          map[string]any `json:"config"`
	}
	canonical := make([]digestItem, len(items))
	for index, item := range items {
		canonical[index] = digestItem{
			SkillID: item.SkillID, ManifestID: item.ManifestID,
			ManifestVersion: item.ManifestVersion, Name: item.Name,
			PackageSHA256: item.PackageSHA256, Source: item.Source, Config: item.Config,
		}
	}
	encoded, err := json.Marshal(struct {
		Schema string       `json:"schema"`
		Items  []digestItem `json:"items"`
	}{Schema: "teamhub.effective-skill-set.v1", Items: canonical})
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(encoded)
	return digest[:], nil
}

func validIdentity(identity Identity) bool {
	return identity.AgentID != "" && validPolicyIdentity(identity)
}

func validPolicyIdentity(identity Identity) bool {
	return identity.AgentActorID != "" && identity.TenantID != "" &&
		validAgentType(identity.AgentType)
}

func validAgentType(agentType string) bool {
	return agentType == "general" || agentType == "anotherme"
}
