-- Disposable regression fixture: seven visible General Agents with eight current
-- catalog defaults each plus five explicit bindings on the official Agent,
-- and an unrequested Agent's bindings over the real built-in Skill catalog.
INSERT INTO actors(id,tenant_id,kind,display_name,handle)
SELECT 'actor_directory_' || n,'tenant_acme','agent','Directory Agent ' || n,'@directory-' || n
FROM generate_series(1,6) n;
INSERT INTO agent_registrations(actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,agent_type,
                                computer_id,local_runtime_type,workspace_grant_id)
SELECT 'actor_directory_' || n,'tenant_acme','management_directory_' || n,'active',
       'Isolated directory regression fixture','gpt-5','actor_acme_alice','general',
       'computer_fixture','codex','grant_files'
FROM generate_series(1,6) n;
INSERT INTO actors(id,tenant_id,kind,display_name,handle)
VALUES('actor_directory_other','tenant_acme','agent','Other Directory Agent','@directory-other');
INSERT INTO agent_registrations(actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,
                                computer_id,local_runtime_type,workspace_grant_id)
VALUES('actor_directory_other','tenant_acme','management_directory_other','active','Unrelated history','gpt-5','actor_acme_alice',
       'computer_fixture','codex','grant_files');

WITH candidates AS (
    SELECT skill.skill_id,manifest.manifest_version,row_number() OVER (ORDER BY skill.skill_id) AS n
    FROM skills skill
    JOIN skill_manifests manifest ON manifest.manifest_id=skill.latest_manifest_id
    WHERE skill.owner_kind='platform' AND cardinality(skill.default_agent_types)=0
)
INSERT INTO agent_skill_bindings(id,tenant_id,agent_actor_id,skill_id,manifest_version,enabled,config,binding_version,updated_by_actor_id)
SELECT 'directory_background_' || n,'tenant_acme','actor_directory_other',
       skill_id,manifest_version,true,'{}',1,'actor_acme_alice'
FROM candidates WHERE n<=103;

INSERT INTO agent_skill_bindings(id,tenant_id,agent_actor_id,skill_id,manifest_version,enabled,config,binding_version,updated_by_actor_id)
SELECT 'directory_selected_' || row_number() OVER (ORDER BY skill_id),'tenant_acme',
       'actor_acme_official',skill_id,manifest_version,true,'{}',1,'actor_acme_alice'
FROM agent_skill_bindings WHERE id LIKE 'directory_background_%' ORDER BY skill_id LIMIT 5;

ANALYZE skills;
ANALYZE skill_manifests;
ANALYZE agent_skill_bindings;
ANALYZE agent_registrations;
