-- psql -X -qAt -v ON_ERROR_STOP=1 -v profile_hours=24 -f agent-wake-topology-profile.sql
-- Optional profile_until pins a completed UTC minute for comparison with another sample.
-- Counts retained facts, not NOTIFY delivery, decoder invocations or discovered Contexts.
\if :{?profile_hours}
\else
\set profile_hours 24
\endif
\if :{?profile_until}
\else
\set profile_until now
\endif
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL timezone = 'UTC';
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
-- A missing authorization function is unknown, never zero receivers. Select
-- the SQL fragment before parsing the query so older schemas remain readable.
SELECT to_regprocedure('agent_context_can_receive_inbox(text,text)') IS NOT NULL AS receiver_supported,
       CASE WHEN to_regprocedure('agent_context_can_receive_inbox(text,text)') IS NOT NULL
            THEN 'agent_context_can_receive_inbox(context.context_key,candidate.inbox_id)'
            ELSE 'false' END AS receiver_predicate
\gset
WITH bounds AS (
    SELECT until,until-make_interval(hours=>least(168,greatest(1,:'profile_hours'::int))) AS since
    FROM (SELECT date_trunc('minute',least(now(),:'profile_until'::timestamptz)) AS until) cutoff
), events AS MATERIALIZED (
    SELECT event.tenant_id,event.room_id,event.event_type,event.occurred_at,
           coalesce(thread.parent_room_id,event.room_id) AS membership_room_id
    FROM room_events event CROSS JOIN bounds
    LEFT JOIN rooms thread ON thread.id=event.room_id AND thread.tenant_id=event.tenant_id
    WHERE event.room_seq>0 AND event.occurred_at>=since AND event.occurred_at<until
), event_rooms AS (
    SELECT DISTINCT tenant_id,room_id,membership_room_id FROM events
), inboxes AS (
    SELECT r.tenant_id,r.room_id,r.membership_room_id,'room:'||r.room_id AS inbox_id,NULL::text AS task_id FROM event_rooms r
    WHERE NOT EXISTS(SELECT 1 FROM rooms t WHERE t.id=r.room_id AND t.tenant_id=r.tenant_id AND t.parent_room_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM work_item_room_links l JOIN work_items i ON i.id=l.work_item_id AND i.tenant_id=l.tenant_id AND i.kind='task'
                     WHERE l.room_id=r.room_id AND l.tenant_id=r.tenant_id AND l.link_type='work')
    UNION ALL
    SELECT r.tenant_id,r.room_id,r.membership_room_id,'thread:'||r.room_id,NULL::text FROM event_rooms r
    JOIN rooms t ON t.id=r.room_id AND t.tenant_id=r.tenant_id AND t.parent_room_id IS NOT NULL
    UNION ALL
    SELECT r.tenant_id,r.room_id,r.membership_room_id,'task:'||l.work_item_id,l.work_item_id FROM event_rooms r
    JOIN work_item_room_links l ON l.room_id=r.room_id AND l.tenant_id=r.tenant_id AND l.link_type='work'
    JOIN work_items i ON i.id=l.work_item_id AND i.tenant_id=l.tenant_id AND i.kind='task'
), task_inboxes AS MATERIALIZED (
    SELECT inbox.*,generation.generation,generation.coordinator_actor_id,generation.coordinator_context_key
    FROM inboxes inbox JOIN work_items item ON item.id=inbox.task_id AND item.tenant_id=inbox.tenant_id
    JOIN task_execution_generations generation ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id
      AND generation.generation=item.task_execution_generation
    WHERE :'receiver_supported'::boolean
), task_actors AS (
    -- With no explicit coordinator Context, actor_can_read_inbox admits the
    -- coordinator, Room members, current participants and assignees.
    SELECT tenant_id,room_id,inbox_id,coordinator_actor_id AS actor_id FROM task_inboxes
    WHERE coordinator_context_key IS NULL AND coordinator_actor_id IS NOT NULL
    UNION
    SELECT inbox.tenant_id,inbox.room_id,inbox.inbox_id,member.actor_id
    FROM task_inboxes inbox JOIN active_room_members member ON member.room_id=inbox.room_id AND member.tenant_id=inbox.tenant_id
    WHERE inbox.coordinator_context_key IS NULL
    UNION
    SELECT inbox.tenant_id,inbox.room_id,inbox.inbox_id,participant.actor_id
    FROM task_inboxes inbox JOIN task_execution_participants participant ON participant.task_id=inbox.task_id
      AND participant.tenant_id=inbox.tenant_id AND participant.generation=inbox.generation
    WHERE inbox.coordinator_context_key IS NULL
    UNION
    SELECT inbox.tenant_id,inbox.room_id,inbox.inbox_id,assignment.actor_id
    FROM task_inboxes inbox JOIN work_item_assignments assignment ON assignment.work_item_id=inbox.task_id AND assignment.tenant_id=inbox.tenant_id
    WHERE inbox.coordinator_context_key IS NULL
), receiver_candidates AS MATERIALIZED (
    -- Reverse ListDirectInboxCandidates' membership/owner scope. The shared
    -- predicate remains authoritative for participation, epochs and Thread lists.
    SELECT inbox.tenant_id,inbox.room_id,inbox.inbox_id,context.context_key
    FROM inboxes inbox JOIN active_room_members member ON member.room_id=inbox.membership_room_id AND member.tenant_id=inbox.tenant_id
    JOIN agent_execution_contexts context ON context.tenant_id=member.tenant_id AND context.agent_actor_id=member.actor_id
      AND context.context_kind='meta' AND context.terminal_reason IS NULL
      AND (context.room_id IS NULL OR context.room_id=member.room_id)
    WHERE :'receiver_supported'::boolean AND inbox.task_id IS NULL
    UNION
    SELECT inbox.tenant_id,inbox.room_id,inbox.inbox_id,context.context_key
    FROM task_inboxes inbox JOIN agent_execution_contexts context ON context.context_key=inbox.coordinator_context_key
      AND context.tenant_id=inbox.tenant_id AND context.agent_actor_id=inbox.coordinator_actor_id
      AND context.context_kind='meta' AND context.terminal_reason IS NULL
    UNION
    SELECT actor.tenant_id,actor.room_id,actor.inbox_id,context.context_key
    FROM task_actors actor JOIN agent_execution_contexts context ON context.tenant_id=actor.tenant_id AND context.agent_actor_id=actor.actor_id
      AND context.context_kind='meta' AND context.terminal_reason IS NULL
      AND (context.room_id IS NULL OR context.room_id=actor.room_id)
), eligible_receivers AS MATERIALIZED (
    SELECT candidate.tenant_id,candidate.room_id FROM receiver_candidates candidate
    JOIN agent_execution_contexts context ON context.context_key=candidate.context_key
    JOIN agent_registrations registration ON registration.tenant_id=context.tenant_id
      AND registration.actor_id=context.agent_actor_id AND registration.agent_management_id=context.agent_management_id
      AND registration.status='active'
    JOIN actors actor ON actor.id=context.agent_actor_id AND actor.tenant_id=context.tenant_id AND actor.kind='agent'
    WHERE :receiver_predicate AND (context.room_id IS NULL OR EXISTS(
        SELECT 1 FROM active_room_members member WHERE member.room_id=context.room_id AND member.tenant_id=context.tenant_id
          AND member.actor_id=context.agent_actor_id AND member.membership_epoch_id=context.membership_epoch_id))
), room_receivers AS MATERIALIZED (
    SELECT r.*,
        EXISTS(SELECT 1 FROM room_members m
               JOIN actors actor ON actor.id=m.actor_id AND actor.tenant_id=m.tenant_id AND actor.kind='agent'
               WHERE m.tenant_id=r.tenant_id AND m.room_id=r.membership_room_id) AS current_agent_member,
        EXISTS(SELECT 1 FROM eligible_receivers receiver WHERE receiver.tenant_id=r.tenant_id AND receiver.room_id=r.room_id) AS current_receiver
    FROM event_rooms r
), measured_events AS MATERIALIZED (
    SELECT e.*,r.current_agent_member,r.current_receiver
    FROM events e JOIN room_receivers r USING(tenant_id,room_id,membership_room_id)
), topology AS (
    SELECT tenant_id,created_at AS occurred_at,'rooms_created' AS metric FROM rooms CROSS JOIN bounds
    WHERE created_at>=since AND created_at<until
      AND parent_room_id IS NULL
    UNION ALL SELECT tenant_id,created_at,'threads_created' FROM rooms CROSS JOIN bounds
    WHERE parent_room_id IS NOT NULL AND created_at>=since AND created_at<until
    UNION ALL SELECT tenant_id,created_at,'task_generations_created' FROM task_execution_generations CROSS JOIN bounds WHERE created_at>=since AND created_at<until
    UNION ALL
    SELECT event.tenant_id,event.occurred_at,change.metric FROM room_events event CROSS JOIN bounds
    JOIN actors actor ON actor.id=event.resource_id AND actor.tenant_id=event.tenant_id
    CROSS JOIN LATERAL (VALUES
        (CASE event.event_type WHEN 'room.member.added' THEN 'members_added' ELSE 'members_removed' END),
        (CASE WHEN actor.kind='agent' THEN CASE event.event_type WHEN 'room.member.added' THEN 'agent_members_added' ELSE 'agent_members_removed' END END)
    ) change(metric)
    WHERE event.event_type IN ('room.member.added','room.member.removed')
      AND event.occurred_at>=since AND event.occurred_at<until AND change.metric IS NOT NULL
), metrics(metric) AS (VALUES
    ('room_events'),('non_message_room_events'),('events_with_current_agent_member'),
    ('events_with_current_receiver'),('rooms_created'),('threads_created'),('members_added'),('members_removed'),
    ('agent_members_added'),('agent_members_removed'),('task_generations_created')
), counts AS MATERIALIZED (
    SELECT tenant_id,date_trunc('minute',occurred_at) AS minute,metric,count(*) AS value
    FROM measured_events CROSS JOIN LATERAL (VALUES
        ('room_events',true),('non_message_room_events',event_type<>'message.created'),
        ('events_with_current_agent_member',current_agent_member),
        ('events_with_current_receiver',current_receiver)
    ) measurement(metric,included) WHERE included GROUP BY 1,2,3
    UNION ALL
    SELECT tenant_id,date_trunc('minute',occurred_at),metric,count(*) FROM topology GROUP BY 1,2,3
), minute_counts AS MATERIALIZED (
    SELECT tenant_id,minute,metric,value FROM counts
    UNION ALL
    SELECT NULL::text,minute,metric,sum(value)::bigint FROM counts GROUP BY minute,metric
), nonzero_stats AS (
    SELECT tenant_id,metric,sum(value) AS total,max(value) AS peak,count(*) AS nonzero_minutes,
        array_agg(value ORDER BY value) AS positive_values FROM minute_counts GROUP BY tenant_id,metric
), totals AS MATERIALIZED (
    SELECT tenant.tenant_id,metrics.metric,coalesce(stat.total,0) AS total,coalesce(stat.peak,0) AS peak,
        coalesce(stat.nonzero_minutes,0) AS nonzero_minutes,stat.positive_values,extract(epoch FROM until-since)::int/60 AS minutes
    FROM (SELECT DISTINCT tenant_id FROM actors WHERE kind='human' UNION ALL SELECT NULL::text) tenant CROSS JOIN metrics CROSS JOIN bounds
    LEFT JOIN nonzero_stats stat ON stat.tenant_id IS NOT DISTINCT FROM tenant.tenant_id AND stat.metric=metrics.metric
), distributions AS (
    -- percentile_disc selects ceil(p*N). Skip the implicit leading zeros to
    -- index sorted positive minutes; no Tenant x metric x minute expansion.
    SELECT tenant_id,metric,CASE WHEN metric='events_with_current_receiver' AND NOT :'receiver_supported'::boolean THEN NULL
        ELSE jsonb_build_object('total',total,'mean_per_minute',round(total::numeric/minutes,4),'peak',peak,
            'p50',CASE WHEN rank.p50>0 THEN positive_values[rank.p50] ELSE 0 END,
            'p95',CASE WHEN rank.p95>0 THEN positive_values[rank.p95] ELSE 0 END,
            'p99',CASE WHEN rank.p99>0 THEN positive_values[rank.p99] ELSE 0 END,'nonzero_minutes',nonzero_minutes) END AS distribution
    FROM totals CROSS JOIN LATERAL (SELECT
        (ceil(.50*minutes)-(minutes-nonzero_minutes))::int AS p50,
        (ceil(.95*minutes)-(minutes-nonzero_minutes))::int AS p95,
        (ceil(.99*minutes)-(minutes-nonzero_minutes))::int AS p99) rank
), profiles AS (
    SELECT tenant_id,jsonb_object_agg(metric,distribution) AS metrics FROM distributions GROUP BY tenant_id
), ratios AS (
    SELECT tenant_id,
        round(sum(total) FILTER(WHERE metric='events_with_current_agent_member')::numeric/nullif(sum(total) FILTER(WHERE metric='room_events'),0),6) AS current_agent_member,
        CASE WHEN :'receiver_supported'::boolean THEN round(sum(total) FILTER(WHERE metric='events_with_current_receiver')::numeric/nullif(sum(total) FILTER(WHERE metric='room_events'),0),6) END AS current_receiver
    FROM totals GROUP BY tenant_id
), event_types AS (
    SELECT event_type,count(*) AS events FROM events GROUP BY event_type
)
SELECT jsonb_build_object('database',current_database(),'schema',current_schema(),'observed_at',now(),
    'since',since,'until',until,'minutes',extract(epoch FROM until-since)::int/60,
    'schema_version',(SELECT max(version_id) FROM goose_db_version WHERE is_applied),
    'receiver_supported',:'receiver_supported'::boolean,'receiver_basis','current_authorization_snapshot_replay',
    'global',(SELECT jsonb_build_object('metrics',p.metrics,'event_ratios',to_jsonb(r)-'tenant_id') FROM profiles p JOIN ratios r ON p.tenant_id IS NOT DISTINCT FROM r.tenant_id WHERE p.tenant_id IS NULL),
    'tenants',coalesce((SELECT jsonb_agg(jsonb_build_object('tenant',left(md5(p.tenant_id),12),'metrics',p.metrics,'event_ratios',to_jsonb(r)-'tenant_id') ORDER BY p.tenant_id)
                        FROM profiles p JOIN ratios r USING(tenant_id)),'[]'::jsonb),
    'event_types',coalesce((SELECT jsonb_object_agg(event_type,events) FROM event_types),'{}'::jsonb),
    'global_nonzero_minutes',coalesce((SELECT jsonb_agg(jsonb_build_object('minute',minute,'metric',metric,'count',value) ORDER BY minute,metric)
        FROM minute_counts WHERE tenant_id IS NULL AND (metric<>'events_with_current_receiver' OR :'receiver_supported'::boolean)),'[]'::jsonb))
FROM bounds;
COMMIT;
