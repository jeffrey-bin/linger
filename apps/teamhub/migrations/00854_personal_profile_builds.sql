-- +goose Up
-- A Profile build an Agent has started for its Human. The Profile page shows
-- that the Profile is being written until the next revision or expires_at.
CREATE TABLE personal_profile_builds (
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    started_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamp with time zone NOT NULL,
    PRIMARY KEY (tenant_id, owner_actor_id),
    FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES actors (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT personal_profile_builds_window_check CHECK (expires_at > started_at)
);

-- +goose Down
DROP TABLE personal_profile_builds;
