// Package registration holds the Local Runtime Registrations the Runner
// Gateway sends this Daemon.
package registration

import (
	"context"
	"errors"
	"slices"
	"sort"
	"sync"
)

// ErrRevisionConflict reports a Registration whose revision disagrees with the
// one held.
var ErrRevisionConflict = errors.New("Local Runtime Registration revision conflicts with retained state")

// MemoryStore holds the Registrations the Gateway sent this Daemon process.
// The Gateway sends them again on every connection, so they are not kept
// across a restart.
type MemoryStore struct {
	mu    sync.Mutex
	items map[string]Observation
}

// NewMemoryStore returns an empty store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{items: make(map[string]Observation)}
}

// Apply records a Registration unless a newer revision is held.
func (s *MemoryStore) Apply(_ context.Context, observation Observation) (Observation, error) {
	if err := validate(observation); err != nil {
		return Observation{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.items[observation.RegistrationID]
	if !ok {
		for id, conflicting := range s.items {
			if conflicting.Key != observation.Key {
				continue
			}
			if observation.Revision <= conflicting.Revision {
				return Observation{}, ErrIdentityCollision
			}
			delete(s.items, id)
		}
		s.items[observation.RegistrationID] = clone(observation)
		return clone(observation), nil
	}
	if current.Key != observation.Key {
		return Observation{}, ErrIdentityCollision
	}
	if observation.Revision < current.Revision {
		return clone(current), nil
	}
	if observation.Revision == current.Revision {
		if !equalObservation(current, observation) {
			return Observation{}, ErrRevisionConflict
		}
		return clone(current), nil
	}
	s.items[observation.RegistrationID] = clone(observation)
	return clone(observation), nil
}

// List returns the held Registrations.
func (s *MemoryStore) List(context.Context) ([]Observation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]Observation, 0, len(s.items))
	for _, item := range s.items {
		result = append(result, clone(item))
	}
	sort.Slice(result, func(i, j int) bool { return result[i].RegistrationID < result[j].RegistrationID })
	return result, nil
}

func equalObservation(left, right Observation) bool {
	return left.RegistrationID == right.RegistrationID && left.Key == right.Key && left.Status == right.Status &&
		left.Revision == right.Revision && slices.Equal(left.Capabilities, right.Capabilities)
}

var _ Store = (*MemoryStore)(nil)
