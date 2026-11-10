package registration

import (
	"context"
	"errors"
	"fmt"
)

type Status string

const (
	StatusOnline      Status = "online"
	StatusOffline     Status = "offline"
	StatusUnavailable Status = "unavailable"
)

type Key struct {
	DaemonID     string
	TenantID     string
	OwnerActorID string
	ProviderType string
}

type Observation struct {
	RegistrationID string
	Key            Key
	Status         Status
	Revision       uint64
	Capabilities   []string
}

type Store interface {
	Apply(context.Context, Observation) (Observation, error)
	List(context.Context) ([]Observation, error)
}

var (
	ErrInvalidObservation = errors.New("invalid Local Runtime Registration observation")
	ErrIdentityCollision  = errors.New("Local Runtime Registration identity collision")
)

func validate(observation Observation) error {
	if observation.RegistrationID == "" || observation.Key.DaemonID == "" || observation.Key.TenantID == "" || observation.Key.OwnerActorID == "" || observation.Key.ProviderType == "" || observation.Revision == 0 {
		return fmt.Errorf("%w: registration id, owner scope, provider, and revision are required", ErrInvalidObservation)
	}
	switch observation.Status {
	case StatusOnline, StatusOffline, StatusUnavailable:
		return nil
	default:
		return fmt.Errorf("%w: unknown status %q", ErrInvalidObservation, observation.Status)
	}
}

func clone(observation Observation) Observation {
	observation.Capabilities = append([]string{}, observation.Capabilities...)
	return observation
}
