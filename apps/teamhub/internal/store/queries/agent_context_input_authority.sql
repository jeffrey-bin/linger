-- name: SettleAgentContextInputsForMembershipRevocation :execrows
UPDATE agent_runtime_inputs input
SET status='handled',
    selection_result=jsonb_build_object(
        'selected','discard','reason','room_membership_revoked'
    ),
    steer_outcome='uncertain',
    updated_at=clock_timestamp()
WHERE input.context_key=sqlc.arg(context_key)::text
  AND input.status='steering';
