// Package account owns TeamHub Account provisioning, password hashing and
// changes, the Settings profile, and Tenant change hints. A deployment has one
// operator-created Account; there is no public registration, email delivery,
// or Tenant invitation.
package account

import (
	"crypto/rand"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Lifecycle struct {
	pool *pgxpool.Pool
}

func NewLifecycle(pool *pgxpool.Pool) *Lifecycle {
	return &Lifecycle{pool: pool}
}

type RateLimitError struct {
	RetryAfter time.Duration
}

func (e *RateLimitError) Error() string { return "password change is rate limited" }

var ErrInvalidEmail = errors.New("invalid email address")

// maxEmailLocalPart keeps the local part, which names the owner's Human Actor
// and Tenant, inside their 120-character name limits.
const maxEmailLocalPart = 100

func normalizeEmail(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	parsed, err := mail.ParseAddress(normalized)
	if err != nil || parsed.Address != normalized || len(normalized) > 320 ||
		utf8.RuneCountInString(normalized[:strings.LastIndexByte(normalized, '@')]) > maxEmailLocalPart {
		return "", ErrInvalidEmail
	}
	return normalized, nil
}

func newRandomID(prefix string) (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", fmt.Errorf("generate %s id: %w", prefix, err)
	}
	return fmt.Sprintf("%s_%x", prefix, data), nil
}
