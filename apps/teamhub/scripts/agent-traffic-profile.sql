-- psql -X -A -t -v ON_ERROR_STOP=1 -v profile_hours=24 -f agent-traffic-profile.sql
-- Completed UTC minutes only. No message bodies, account names or credentials.
\if :{?profile_hours}
\else
\set profile_hours 24
\endif
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
WITH bounds AS (
    SELECT date_trunc('minute',now()) AS until,
           date_trunc('minute',now())-make_interval(hours=>least(168,greatest(1,:'profile_hours'::int))) AS since
), source_messages AS MATERIALIZED (
    SELECT id,tenant_id,created_at FROM messages,bounds WHERE created_at>=since AND created_at<until
    UNION ALL
    SELECT id,tenant_id,created_at FROM task_meta_messages,bounds WHERE created_at>=since AND created_at<until
    UNION ALL
    SELECT id,tenant_id,created_at FROM task_meta_callback_messages,bounds WHERE created_at>=since AND created_at<until
), message_counts AS (
    SELECT tenant_id,date_trunc('minute',created_at) AS minute,count(*) AS messages FROM source_messages GROUP BY 1,2
), mentions AS (
    SELECT m.tenant_id,date_trunc('minute',m.created_at) AS minute,count(*) AS agent_mentions
    FROM messages m CROSS JOIN bounds CROSS JOIN LATERAL unnest(m.mentioned_actor_ids) AS mention(target_actor_id)
    JOIN actors target ON target.id=mention.target_actor_id AND target.tenant_id=m.tenant_id AND target.kind='agent'
    WHERE m.created_at>=since AND m.created_at<until
    GROUP BY 1,2
), active AS (
    SELECT c.tenant_id,date_trunc('minute',i.created_at) AS minute,count(DISTINCT i.context_key) AS active_contexts
    FROM agent_runtime_inputs i JOIN agent_execution_contexts c USING(context_key),bounds
    WHERE i.created_at>=since AND i.created_at<until GROUP BY 1,2
), samples AS (
    SELECT t.id AS tenant_id,timeline.minute,coalesce(m.messages,0) AS messages,coalesce(a.agent_mentions,0) AS agent_mentions,
           coalesce(c.active_contexts,0) AS active_contexts
    FROM (SELECT DISTINCT tenant_id AS id FROM actors WHERE kind='human') t CROSS JOIN bounds CROSS JOIN LATERAL generate_series(since,until-interval '1 minute',interval '1 minute') AS timeline(minute)
    LEFT JOIN message_counts m ON m.tenant_id=t.id AND m.minute=timeline.minute
    LEFT JOIN mentions a ON a.tenant_id=t.id AND a.minute=timeline.minute
    LEFT JOIN active c ON c.tenant_id=t.id AND c.minute=timeline.minute
), distributions AS (
    SELECT tenant_id,metric,jsonb_build_object('total',sum(value),'peak',max(value),
        'p50',percentile_disc(.50) WITHIN GROUP(ORDER BY value),'p95',percentile_disc(.95) WITHIN GROUP(ORDER BY value),
        'p99',percentile_disc(.99) WITHIN GROUP(ORDER BY value),'nonzero_minutes',count(*) FILTER(WHERE value>0)) AS distribution
    FROM samples CROSS JOIN LATERAL (VALUES ('messages',messages),('agent_mentions',agent_mentions),
        ('active_contexts',active_contexts)) metrics(metric,value)
    GROUP BY tenant_id,metric
), tenant_profiles AS (
    SELECT tenant_id,jsonb_object_agg(metric,distribution) AS metrics FROM distributions GROUP BY tenant_id
), epoch AS (
    SELECT epoch.epoch,epoch.started_at,
        (SELECT count(*) FROM agent_local_runs run WHERE run.status='running' AND run.epoch=epoch.epoch) AS running_runs,
        (SELECT count(*) FROM agent_execution_contexts context WHERE context.target_residency='active' AND context.terminal_reason IS NULL) AS active_targets
    FROM agent_service_epochs epoch
)
SELECT jsonb_build_object('database',current_database(),'schema',current_schema(),'observed_at',now(),
    'since',since,'until',until,'minutes',extract(epoch FROM until-since)::int/60,
    'schema_version',(SELECT max(version_id) FROM goose_db_version WHERE is_applied),
    'tenants',coalesce((SELECT jsonb_agg(jsonb_build_object('tenant',left(md5(tenant_id),12),'metrics',metrics) ORDER BY tenant_id) FROM tenant_profiles),'[]'::jsonb),
    'agent_service_epoch',(SELECT jsonb_build_object('started_at',started_at,'running_runs',running_runs,'active_targets',active_targets) FROM epoch))
FROM bounds;
COMMIT;
