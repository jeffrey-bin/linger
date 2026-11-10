-- +goose Up
-- Memory compares a new Profile Revision with the one memory.md was built
-- from, so facts the Human removed from their Profile leave memory.md too.
CREATE VIEW memory_source.personal_profile_revisions AS
SELECT id, tenant_id, owner_actor_id, markdown
FROM public.personal_profile_revisions;

-- +goose Down
DROP VIEW memory_source.personal_profile_revisions;
