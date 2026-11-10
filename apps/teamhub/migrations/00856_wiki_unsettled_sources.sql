-- +goose Up
-- A source a Wiki refresh left unwritten (a skipped model task, the
-- generation's time budget, or pages validation dropped) stays pending: the
-- published sources keep its earlier version, so a later refresh writes it
-- again. This counts the refreshes that left one version unwritten; after
-- three it settles anyway, so a source that always fails cannot hold the Wiki.
CREATE TABLE document_wiki_unsettled_sources (
    wiki_id text NOT NULL,
    tenant_id text NOT NULL,
    document_id text NOT NULL,
    document_version_id text NOT NULL,
    tries smallint NOT NULL CONSTRAINT document_wiki_unsettled_sources_tries_check CHECK (tries > 0),
    PRIMARY KEY (wiki_id, document_id),
    FOREIGN KEY (wiki_id, tenant_id) REFERENCES personal_wikis (id, tenant_id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE document_wiki_unsettled_sources;
