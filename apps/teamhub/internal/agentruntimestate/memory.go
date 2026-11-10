package agentruntimestate

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Memory is derived data. Contexts, accepted inputs and Local Runs remain the
// sole execution authority; this document only records extraction/publication progress.
func (s *Service) ReadMemory(ctx context.Context, agentID string) (json.RawMessage, error) {
	var data []byte
	// The revision column is the CAS authority; document.revision may lag it.
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(jsonb_set(m.document,'{revision}',to_jsonb(m.revision)), '{"revision":0,"summary":"","memory":"","sessions":{},"cursors":{}}'::jsonb)
        FROM agent_registrations a LEFT JOIN agent_memories m ON m.agent_id=a.agent_management_id
        WHERE a.agent_management_id=$1 AND a.status='active'`, agentID).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return data, err
}

func (s *Service) CommitMemory(ctx context.Context, agentID string, revision int64, document json.RawMessage) (json.RawMessage, error) {
	if revision < 0 || revision >= 9007199254740991 || len(document) > 4<<20 || !json.Valid(document) {
		return nil, ErrInvalid
	}
	var result []byte

	var err error
	if revision == 0 {
		err = s.pool.QueryRow(ctx, `INSERT INTO agent_memories(agent_id,revision,document)
          SELECT agent_management_id,1,jsonb_set($2::jsonb,'{revision}','1'::jsonb)
          FROM agent_registrations WHERE agent_management_id=$1 AND status='active'
          ON CONFLICT (agent_id) DO NOTHING RETURNING document`, agentID, document).Scan(&result)
	} else {
		err = s.pool.QueryRow(ctx, `UPDATE agent_memories m SET revision=m.revision+1,
            document=jsonb_set($3::jsonb,'{revision}',to_jsonb(m.revision+1))
            FROM agent_registrations a WHERE m.agent_id=$1 AND m.revision=$2
            AND a.agent_management_id=m.agent_id AND a.status='active' RETURNING m.document`, agentID, revision, document).Scan(&result)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrConflict
	}
	return result, err
}
