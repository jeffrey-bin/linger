-- name: HideMeeting :one
-- Hides a Capture's meeting from the Space's Human on every device; found is
-- false when the Capture is not in the Space. Hiding it again keeps the first
-- time.
WITH capture AS (
    UPDATE capture_sessions SET hidden_at=coalesce(hidden_at,now())
    WHERE id=sqlc.arg(capture_session_id)::text AND tenant_id=sqlc.arg(tenant_id)::text
    RETURNING id
)
SELECT EXISTS(SELECT 1 FROM capture)::boolean AS found;
