-- +goose Up
-- A provider_key card asks a Human for the deployment's Composio API key that
-- every Connected App needs; saving the key answers it.
ALTER TABLE decisions DROP CONSTRAINT decisions_kind_check;
ALTER TABLE decisions ADD CONSTRAINT decisions_kind_check CHECK (kind = ANY (ARRAY[
    'connector_write', 'agent_change', 'question', 'runtime_permission', 'profile_setup_apps',
    'profile_setup_sources', 'connection_auth', 'provider_key', 'browser_connection',
    'room_creation', 'computer_permission'
]));

-- +goose Down
DELETE FROM decisions WHERE kind = 'provider_key';
ALTER TABLE decisions DROP CONSTRAINT decisions_kind_check;
ALTER TABLE decisions ADD CONSTRAINT decisions_kind_check CHECK (kind = ANY (ARRAY[
    'connector_write', 'agent_change', 'question', 'runtime_permission', 'profile_setup_apps',
    'profile_setup_sources', 'connection_auth', 'browser_connection', 'room_creation',
    'computer_permission'
]));
