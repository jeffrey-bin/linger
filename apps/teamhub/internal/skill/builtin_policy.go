package skill

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// nextAgentBindingVersion is the Agent binding version a startup policy write
// carries: one past the newest version of any of the Agent's bindings.
const nextAgentBindingVersion = `(SELECT max(other.binding_version)+1 FROM agent_skill_bindings other WHERE other.agent_actor_id=binding.agent_actor_id)`

// repointExplicitBindings moves enabled explicit bindings of advanced Platform
// Skills from their previous Manifest to the new latest one, keeping config.
// A startup write names no Human author.
func repointExplicitBindings(ctx context.Context, tx pgx.Tx, repoints []skillRepoint) error {
	for _, skill := range repoints {
		if _, err := tx.Exec(ctx, `UPDATE agent_skill_bindings binding
 SET manifest_version=manifest.manifest_version,binding_version=`+nextAgentBindingVersion+`,
     updated_by_actor_id=NULL,updated_at=now()
 FROM skill_manifests manifest
 WHERE manifest.manifest_id=$2 AND manifest.skill_id=$1
   AND binding.skill_id=$1 AND binding.enabled AND binding.deleted_at IS NULL
   AND binding.manifest_version<>manifest.manifest_version`, skill.skillID, skill.manifestID); err != nil {
			return err
		}
	}
	return nil
}

// retireDefaultExplicitBindings removes enabled explicit bindings of Platform
// Skills whose defaults include the registration's Agent Type. agentTypes are
// the types startup is about to revalidate. This also covers other Skills
// those Agents explicitly bind when that Skill is already a default for the
// Agent's type, including older Manifests and revoked or otherwise inactive
// registrations.
//
// Retirement drops a live custom selection. The binding row keeps its
// previous config and Manifest and is not deleted.
func retireDefaultExplicitBindings(ctx context.Context, tx pgx.Tx, agentTypes []string) error {
	if len(agentTypes) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `UPDATE agent_skill_bindings binding
 SET enabled=false,deleted_at=now(),binding_version=`+nextAgentBindingVersion+`,
     updated_by_actor_id=NULL,updated_at=now()
 FROM agent_registrations registration,skills skill
 WHERE registration.actor_id=binding.agent_actor_id AND registration.tenant_id=binding.tenant_id
   AND skill.skill_id=binding.skill_id AND skill.owner_kind='platform'
   AND registration.agent_type=ANY(skill.default_agent_types)
   AND registration.agent_type=ANY($1::text[])
   AND binding.enabled AND binding.deleted_at IS NULL`, agentTypes)
	return err
}

func validatePolicyConsumers(ctx context.Context, tx pgx.Tx, skillIDs, agentTypes []string) error {
	for _, agentType := range agentTypes {
		if err := ValidateDefaultBaselineInTx(ctx, tx, agentType); err != nil {
			return fmt.Errorf("%w: %s defaults: %v", ErrBuiltinSkillConflict, agentType, err) //nolint:errorlint // keep the conflict mapping keyed on the builtin conflict sentinel only
		}
	}
	// Include exact consumers outside the defaults and inactive registrations;
	// a global change must not make a previously usable Agent unresumable.
	// Revoked registrations are terminal and never resume.
	rows, err := tx.Query(ctx, `SELECT registration.agent_management_id,registration.actor_id,registration.tenant_id,registration.agent_type
 FROM agent_registrations registration
 WHERE registration.status<>'revoked' AND (registration.agent_type=ANY($1::text[]) OR EXISTS(
  SELECT 1 FROM agent_skill_bindings binding WHERE binding.agent_actor_id=registration.actor_id AND binding.skill_id=ANY($2::text[])
 )) ORDER BY registration.actor_id FOR SHARE OF registration`, agentTypes, skillIDs)
	if err != nil {
		return err
	}
	identities := []Identity{}
	for rows.Next() {
		var identity Identity
		if err = rows.Scan(&identity.AgentID, &identity.AgentActorID, &identity.TenantID, &identity.AgentType); err != nil {
			rows.Close()
			return err
		}
		identities = append(identities, identity)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, identity := range identities {
		if err := ValidateEffectiveInTx(ctx, tx, identity); err != nil {
			return fmt.Errorf("%w: Agent %s effective Skills: %v", ErrBuiltinSkillConflict, identity.AgentID, err) //nolint:errorlint // keep the conflict mapping keyed on the builtin conflict sentinel only
		}
	}
	return nil
}
