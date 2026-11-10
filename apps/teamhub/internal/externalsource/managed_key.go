package externalsource

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

const (
	ManagedKeySourceNone        = "none"
	ManagedKeySourceEnvironment = "environment"
	ManagedKeySourceStored      = "stored"
)

var (
	ErrManagedKeyFromEnvironment = errors.New("the Composio API key is set by the deployment")
	ErrManagedKeyStorageMissing  = errors.New("the deployment has no secret encryption key")
	ErrManagedKeyRejected        = errors.New("Composio rejected the API key")
	ErrManagedKeyForbidden       = errors.New("Composio denied the connection request")
)

type ManagedKeyStatus struct {
	Source  string
	CanSave bool
}

// ManagedKey reports where the Composio API key comes from. The key itself is
// never returned.
func (s *Service) ManagedKey() ManagedKeyStatus {
	if s.managed == nil {
		return ManagedKeyStatus{Source: ManagedKeySourceNone}
	}
	status := ManagedKeyStatus{Source: ManagedKeySourceNone, CanSave: !s.managed.keyFromEnvironment && s.managed.keyBox != nil}
	switch {
	case s.managed.keyFromEnvironment:
		status.Source = ManagedKeySourceEnvironment
	case s.managed.client.Configured():
		status.Source = ManagedKeySourceStored
	}
	return status
}

// SaveManagedKey checks key with Composio, then seals, saves, and applies it.
func (s *Service) SaveManagedKey(ctx context.Context, key string) error {
	key = strings.TrimSpace(key)
	switch {
	case s.managed == nil:
		return ErrUnavailable
	case s.managed.keyFromEnvironment:
		return ErrManagedKeyFromEnvironment
	case s.managed.keyBox == nil:
		return ErrManagedKeyStorageMissing
	case key == "" || len(key) > 512:
		return ErrInvalid
	}
	if err := s.managed.client.WithAPIKey(key).ValidateAPIKey(ctx); err != nil {
		if composio.IsUnauthorized(err) {
			return ErrManagedKeyRejected
		}
		return errors.Join(ErrUnavailable, err)
	}
	sealed, err := s.managed.keyBox.Seal([]byte(key))
	if err != nil {
		return err
	}
	if _, err = s.pool.Exec(ctx, `INSERT INTO composio_settings(api_key_ciphertext) VALUES($1) ON CONFLICT(singleton) DO UPDATE SET api_key_ciphertext=excluded.api_key_ciphertext,updated_at=now()`, sealed); err != nil {
		return err
	}
	s.setManagedKey(key)
	return nil
}

func (s *Service) loadManagedKey(ctx context.Context) error {
	if s.managed.keyFromEnvironment || s.managed.keyBox == nil {
		return nil
	}
	var sealed []byte
	err := s.pool.QueryRow(ctx, `SELECT api_key_ciphertext FROM composio_settings`).Scan(&sealed)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	key, err := s.managed.keyBox.Open(sealed)
	if err != nil {
		return errors.New("open the saved Composio API key: check TEAMHUB_SECRET_ENCRYPTION_KEY")
	}
	s.setManagedKey(string(key))
	return nil
}
