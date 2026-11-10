package agentcredential

import "context"

// DeleteExpired removes unused credentials that can no longer authenticate in
// bounded batches: expired or revoked ones, those of a placement the Agent left
// and those of a deleted Agent. Credentials that
// explain retained business receipts remain as audit evidence, never as valid
// authentication. SKIP LOCKED avoids disturbing in-flight business transactions.
func (s *Service) DeleteExpired(ctx context.Context) (int64, error) {
	var total int64
	for {
		deleted, err := s.deleteExpiredBatch(ctx)
		total += deleted
		if err != nil || deleted < 100 {
			return total, err
		}
	}
}

func (s *Service) deleteExpiredBatch(ctx context.Context) (int64, error) {
	result, err := s.pool.Exec(ctx, `DELETE FROM agent_access_credentials WHERE id IN (
 SELECT credential.id FROM agent_access_credentials credential
 WHERE (credential.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM agent_registrations registration
  WHERE registration.actor_id=credential.agent_actor_id AND registration.tenant_id=credential.tenant_id
  AND registration.agent_management_id=credential.agent_management_id AND registration.status='active'
  AND (credential.assignment_revision IS NULL OR credential.assignment_revision=registration.assignment_revision)))
 AND NOT EXISTS(SELECT 1 FROM command_replays receipt WHERE receipt.credential_id=credential.id)
 ORDER BY credential.created_at LIMIT 100 FOR UPDATE OF credential SKIP LOCKED
 )`)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}
