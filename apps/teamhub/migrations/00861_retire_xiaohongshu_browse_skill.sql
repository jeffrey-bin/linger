-- +goose Up
-- The Xiaohongshu site Skill is retired in favour of the general
-- humanlike-browse Skill. Skills and Manifests are never deleted, so its
-- Manifests are revoked, which hides them from every listing and effective
-- Skill set, and the Agent bindings that named it are removed the way a user
-- removes one: disabled and soft-deleted at the Agent's next binding version.
UPDATE agent_skill_bindings binding
SET enabled=false,
    binding_version=next.binding_version,
    updated_by_actor_id=NULL,
    updated_at=now(),
    deleted_at=now()
FROM (
    SELECT agent_actor_id,max(binding_version)+1 AS binding_version
    FROM agent_skill_bindings
    GROUP BY agent_actor_id
) next
WHERE binding.agent_actor_id=next.agent_actor_id
  AND binding.skill_id='simplexai_xiaohongshu_browse'
  AND binding.deleted_at IS NULL;

UPDATE skill_manifests
SET state='revoked'
WHERE skill_id='simplexai_xiaohongshu_browse'
  AND state<>'revoked';

-- +goose Down
-- Revoked Manifests are terminal, so the retirement is not reversed.
SELECT 1;
