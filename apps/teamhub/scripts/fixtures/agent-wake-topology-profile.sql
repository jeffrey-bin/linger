-- Minimal, disposable relational fixture for the psql sampling script.
-- Authorization functions are loaded verbatim from migrations by the runner.
CREATE TABLE actors(id text PRIMARY KEY,tenant_id text,kind text);
CREATE TABLE rooms(id text PRIMARY KEY,tenant_id text,created_at timestamptz,deleted_at timestamptz,deletion_started_at timestamptz,parent_room_id text,root_message_id text);
CREATE TABLE room_events(tenant_id text,room_id text,room_seq bigint,event_type text,occurred_at timestamptz,resource_id text);
CREATE TABLE messages(id text PRIMARY KEY,author_actor_id text);
CREATE TABLE thread_room_list_actors(thread_room_id text,tenant_id text,actor_id text);
CREATE TABLE room_members(tenant_id text,room_id text,actor_id text,membership_epoch_id text);
CREATE VIEW active_room_members AS SELECT m.* FROM room_members m;
CREATE TABLE room_member_states(room_id text,actor_id text,participation_epoch_id text,left_at timestamptz);
CREATE TABLE agent_registrations(tenant_id text,actor_id text,agent_management_id text,status text);
CREATE TABLE agent_execution_contexts(context_key text PRIMARY KEY,tenant_id text,agent_actor_id text,agent_management_id text,context_kind text,terminal_reason text,room_id text,membership_epoch_id text,task_id text);
CREATE TABLE work_items(id text PRIMARY KEY,tenant_id text,kind text,task_execution_generation int,archived_at timestamptz);
CREATE TABLE work_item_room_links(work_item_id text,tenant_id text,room_id text,link_type text);
CREATE TABLE task_execution_generations(task_id text,tenant_id text,generation int,created_at timestamptz,coordinator_actor_id text,coordinator_context_key text);
CREATE TABLE task_execution_participants(task_id text,tenant_id text,generation int,actor_id text,agent_management_id text);
CREATE TABLE work_item_assignments(work_item_id text,tenant_id text,actor_id text);
CREATE TABLE task_meta_inboxes(task_id text,tenant_id text,agent_actor_id text);
CREATE TABLE task_meta_callbacks(task_id text,tenant_id text,generation int,coordinator_actor_id text,coordinator_context_key text);
CREATE TABLE goose_db_version(version_id bigint,is_applied boolean);
INSERT INTO goose_db_version VALUES(379,true);
INSERT INTO actors VALUES ('a','tenant_1','agent'),('p','tenant_1','agent'),('assigned','tenant_1','agent'),
 ('coord','tenant_1','agent'),('stale','tenant_1','agent'),('revoking','tenant_1','agent'),('h','tenant_1','human'),('b','tenant_2','human');
-- Every Space is the tenant_id of its Human; tenants 3..45 have no traffic.
INSERT INTO actors SELECT 'human_'||n,'tenant_'||n,'human' FROM generate_series(3,45) n;
INSERT INTO rooms(id,tenant_id,created_at)
 SELECT id,'tenant_1','2020-01-01T00:00Z' FROM unnest(ARRAY['r','thread','denied_thread','listed_thread','task_room','unowned_task_room','coordinator_actor_room','no_receiver','stale_epoch_room','revoking_room']) id;
INSERT INTO rooms(id,tenant_id,created_at) VALUES ('r2','tenant_2','2019-01-01Z');
INSERT INTO rooms(id,tenant_id,created_at) SELECT 'other_'||n,'tenant_1','2019-01-01Z' FROM generate_series(1,500) n;
INSERT INTO messages VALUES ('agent_root','a'),('human_root','h');
UPDATE rooms room SET parent_room_id='r',root_message_id=thread.root_message_id,created_at=thread.created_at
FROM (VALUES ('thread','agent_root','2020-01-01T00:01Z'::timestamptz),('denied_thread','human_root','2020-01-01T00:02Z'),
 ('listed_thread','human_root','2020-01-01T00:03Z')) thread(id,root_message_id,created_at) WHERE room.id=thread.id;
INSERT INTO thread_room_list_actors VALUES ('thread','tenant_1','h'),('listed_thread','tenant_1','a');
-- The removed member of revoking_room keeps a Context bound to its old admission.
INSERT INTO room_members VALUES
 ('tenant_1','r','a','r_a'),('tenant_1','unowned_task_room','a','task_a'),('tenant_1','stale_epoch_room','stale','stale_new');
INSERT INTO room_members SELECT 'tenant_1','other_'||n,'a','other_epoch_'||n FROM generate_series(1,500) n;
INSERT INTO agent_registrations SELECT 'tenant_1',id,'mgmt_'||id,'active' FROM actors WHERE kind='agent';
-- Unrelated per-Room and non-Meta Contexts must never reach the receiver predicate.
INSERT INTO agent_execution_contexts(context_key,tenant_id,agent_actor_id,agent_management_id,context_kind,room_id,membership_epoch_id)
 SELECT 'unrelated_'||n,'tenant_1','a','mgmt_a','meta','other_'||n,'other_epoch_'||n FROM generate_series(1,500) n;
INSERT INTO agent_execution_contexts VALUES
 ('unrelated_kind','tenant_1','a','mgmt_a','document',NULL,'r','r_a',NULL),
 ('global_a','tenant_1','a','mgmt_a','meta',NULL,NULL,NULL,NULL),
 ('room_a','tenant_1','a','mgmt_a','meta',NULL,'r','r_a',NULL),
 ('task_a','tenant_1','a','mgmt_a','meta',NULL,'unowned_task_room','task_a',NULL),
 ('global_p','tenant_1','p','mgmt_p','meta',NULL,NULL,NULL,NULL),
 ('global_assigned','tenant_1','assigned','mgmt_assigned','meta',NULL,NULL,NULL,NULL),
 ('global_coord','tenant_1','coord','mgmt_coord','meta',NULL,NULL,NULL,NULL),
 ('stale_context','tenant_1','stale','mgmt_stale','meta',NULL,'stale_epoch_room','old_epoch',NULL),
 ('revoking_context','tenant_1','revoking','mgmt_revoking','meta',NULL,'revoking_room','revoke',NULL),
 ('terminated','tenant_1','a','mgmt_a','meta','revoked',NULL,NULL,NULL),
 ('wrong_identity','tenant_1','a','wrong_management','meta',NULL,NULL,NULL,NULL);
INSERT INTO work_items VALUES ('explicit_task','tenant_1','task',1,NULL),('unowned_task','tenant_1','task',2,NULL),('coordinator_actor_task','tenant_1','task',1,NULL);
INSERT INTO work_item_room_links VALUES ('explicit_task','tenant_1','task_room','work'),('unowned_task','tenant_1','unowned_task_room','work'),('coordinator_actor_task','tenant_1','coordinator_actor_room','work');
-- A Thread can also be a Task Work Room: exercise Task-only and dual receivers.
INSERT INTO work_items VALUES ('thread_task','tenant_1','task',1,NULL),('listed_thread_task','tenant_1','task',1,NULL),('room_issue','tenant_1','issue',NULL,NULL);
INSERT INTO work_item_room_links VALUES ('thread_task','tenant_1','denied_thread','work'),('listed_thread_task','tenant_1','listed_thread','work'),('room_issue','tenant_1','r','work');
INSERT INTO task_execution_generations VALUES ('thread_task','tenant_1',1,'2020-01-01T00:13Z','coord','global_coord'),('listed_thread_task','tenant_1',1,'2020-01-01T00:14Z','coord','global_coord');
-- Explicit coordinator is a per-Room Context outside this Task's Work Room.
INSERT INTO task_execution_generations VALUES ('explicit_task','tenant_1',1,'2020-01-01T00:10Z','a','room_a'),
 ('unowned_task','tenant_1',1,'2019-12-31Z',NULL,NULL),('unowned_task','tenant_1',2,'2020-01-01T00:11Z',NULL,NULL),
 ('coordinator_actor_task','tenant_1',1,'2020-01-01T00:12Z','coord',NULL);
INSERT INTO task_execution_participants VALUES ('unowned_task','tenant_1',2,'p','mgmt_p');
INSERT INTO work_item_assignments VALUES ('unowned_task','tenant_1','assigned');
INSERT INTO room_events SELECT 'tenant_1',id,1,'message.created','2020-01-01T00:01Z',NULL FROM rooms WHERE tenant_id='tenant_1' AND id NOT LIKE 'other_%';
INSERT INTO room_events(tenant_id,room_id,room_seq,event_type,occurred_at) VALUES ('tenant_1','r',2,'document.created','2020-01-01T00:02Z'),
 ('tenant_1','r',0,'draft.changed','2020-01-01T00:03Z'),('tenant_1','r',3,'message.created','2020-01-01T01:00Z'),
 ('tenant_1','r',4,'message.created','2019-12-31T23:59Z');
-- Membership topology comes from member events; room_seq 0 keeps them out of the event counts above.
INSERT INTO room_events VALUES ('tenant_1','revoking_room',0,'room.member.removed','2020-01-01T00:02Z','revoking'),
 ('tenant_1','r',0,'room.member.removed','2020-01-01T00:06Z','h');
