-- name: RecordAgentLocalRunOperation :exec
-- A Run keeps one entry per Runner Operation, written when the Operation
-- starts with no usage yet; Message activities resolve native records by it.
UPDATE agent_local_runs
SET usage=coalesce(usage,'{}'::jsonb)||jsonb_build_object(sqlc.arg(operation_id)::text,'[]'::jsonb),
    updated_at=clock_timestamp()
WHERE run_id=sqlc.arg(run_id)::text
  AND NOT coalesce(usage,'{}'::jsonb) ? sqlc.arg(operation_id)::text;

-- name: RecordAgentLocalRunUsage :execrows
-- One Runner Operation's usage lands on its Run once; a repeated terminal of
-- the same Operation changes nothing.
UPDATE agent_local_runs
SET usage=coalesce(usage,'{}'::jsonb)||jsonb_build_object(sqlc.arg(operation_id)::text,sqlc.arg(usage)::jsonb),
    updated_at=clock_timestamp()
WHERE run_id=sqlc.arg(run_id)::text
  AND coalesce(usage->sqlc.arg(operation_id)::text,'[]'::jsonb)='[]'::jsonb;

-- name: AddAgentUsageTotals :exec
INSERT INTO agent_usage_totals(provider,model,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,reasoning_tokens,compaction_count)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT (provider,model) DO UPDATE SET
 input_tokens=agent_usage_totals.input_tokens+EXCLUDED.input_tokens,
 cache_read_tokens=agent_usage_totals.cache_read_tokens+EXCLUDED.cache_read_tokens,
 cache_write_tokens=agent_usage_totals.cache_write_tokens+EXCLUDED.cache_write_tokens,
 output_tokens=agent_usage_totals.output_tokens+EXCLUDED.output_tokens,
 reasoning_tokens=agent_usage_totals.reasoning_tokens+EXCLUDED.reasoning_tokens,
 compaction_count=agent_usage_totals.compaction_count+EXCLUDED.compaction_count;
