-- +goose Up
-- The Wiki no longer lists the sources it leaves out, so the record of mail
-- the whitelist filtered out goes. The whitelist still keeps that mail out.
DROP TABLE wiki_source_skips;

-- +goose Down
CREATE TABLE wiki_source_skips (
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    source_key text NOT NULL,
    source text NOT NULL CONSTRAINT wiki_source_skips_source_check CHECK (source IN ('gmail', 'outlook')),
    name text NOT NULL CONSTRAINT wiki_source_skips_name_check CHECK (char_length(name) <= 255),
    reason text NOT NULL CONSTRAINT wiki_source_skips_reason_check CHECK (reason IN ('filtered')),
    skipped_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, owner_actor_id, source_key),
    FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES actors (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX wiki_source_skips_recent ON wiki_source_skips (tenant_id, owner_actor_id, skipped_at DESC);
