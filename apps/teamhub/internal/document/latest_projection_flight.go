package document

import (
	"context"
	"time"
)

type latestProjectionFlight struct {
	done    chan struct{}
	cancel  context.CancelFunc
	waiters int
	settled bool
	err     error
}

// A flight owns compute AND settlement. An object lock acquired after rendering
// cannot prevent competing consumers from loading and rendering the same state.
func (s *Service) ensureLatestProjection(ctx context.Context, tenantID string, candidate latestProjectionCandidate) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	key := tenantID + "\x00" + candidate.documentID + "\x00" + candidate.revisionID + "\x00" + candidate.representationFormat
	s.latestProjectionMu.Lock()
	if s.latestProjectionFlights == nil {
		s.latestProjectionFlights = make(map[string]*latestProjectionFlight)
	}
	flight := s.latestProjectionFlights[key]
	if flight == nil {
		sharedCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		flight = &latestProjectionFlight{done: make(chan struct{}), cancel: cancel}
		s.latestProjectionFlights[key] = flight
		go func() {
			settled, err := s.materializeLatestProjection(sharedCtx, tenantID, candidate)
			s.latestProjectionMu.Lock()
			flight.settled, flight.err = settled, err
			if s.latestProjectionFlights[key] == flight {
				delete(s.latestProjectionFlights, key)
			}
			close(flight.done)
			s.latestProjectionMu.Unlock()
			cancel()
		}()
	}
	flight.waiters++
	s.latestProjectionMu.Unlock()
	defer func() {
		s.latestProjectionMu.Lock()
		flight.waiters--
		if flight.waiters == 0 {
			if s.latestProjectionFlights[key] == flight {
				delete(s.latestProjectionFlights, key)
			}
			flight.cancel()
		}
		s.latestProjectionMu.Unlock()
	}()
	select {
	case <-ctx.Done():
		return false, ctx.Err()
	case <-flight.done:
		return flight.settled, flight.err
	}
}

func (s *Service) materializeLatestProjection(ctx context.Context, tenantID string, candidate latestProjectionCandidate) (bool, error) {
	var current bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM document_latest_projections
		WHERE tenant_id=$1 AND document_id=$2 AND revision_id=$3 AND representation_format=$4
	)`, tenantID, candidate.documentID, candidate.revisionID, candidate.representationFormat).Scan(&current); err != nil {
		return false, err
	}
	if current {
		return true, nil
	}
	projection, err := s.renderRevisionProjection(ctx, tenantID, candidate)
	if err != nil {
		return false, err
	}
	return s.storeAndSettleLatestProjection(ctx, tenantID, candidate, projection)
}
