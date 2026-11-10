package agentconnectedapps

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// An Agent manages auto reminders only for connections its Sponsor's Account
// owns, through the same write path as the Human connection settings.

// ErrNoSponsorAccount reports an Agent without a Human Sponsor Account.
var ErrNoSponsorAccount = errors.New("agent sponsor has no account")

// ErrAutoRemindersNotAnotherMe reports another Agent than Another Me: only it
// acts for its own Human, so only it may switch that Human's auto reminders;
// other Agents can be asked by anyone in a shared Room.
var ErrAutoRemindersNotAnotherMe = errors.New("only Another Me manages auto reminders")

// AutoRemindersAccount authorizes the credential's Another Me and returns the
// Account of its Sponsor, the only owner whose connections it may switch.
func (s *Service) AutoRemindersAccount(ctx context.Context, token string) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	accountID, err := s.autoRemindersAccountTx(ctx, tx, token)
	if err != nil {
		return "", err
	}
	return accountID, tx.Commit(ctx)
}

// SetAutoReminders switches the auto reminders of one of the Sponsor's
// connections for the credential's Another Me and returns the Sponsor's
// Account.
func (s *Service) SetAutoReminders(ctx context.Context, token, connectionID string, enabled bool) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	accountID, err := s.autoRemindersAccountTx(ctx, tx, token)
	if err != nil {
		return "", err
	}
	if err := s.connections.SetAutoRemindersTx(ctx, tx, accountID, connectionID, enabled); err != nil {
		return "", err
	}
	return accountID, tx.Commit(ctx)
}

func (s *Service) autoRemindersAccountTx(ctx context.Context, tx pgx.Tx, token string) (string, error) {
	auth, err := s.contexts.AuthorizeInTx(ctx, tx, token, "manage_auto_reminders")
	if err != nil {
		return "", err
	}
	if auth.Principal == nil || auth.SponsorActorID == "" {
		return "", ErrNoSponsorAccount
	}
	queries := store.New(tx)
	registration, err := queries.GetAgentRegistrationByActor(ctx, store.GetAgentRegistrationByActorParams{
		ActorID: auth.Principal.AgentActorID, TenantID: auth.TenantID,
	})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && registration.AgentType != "anotherme") {
		return "", ErrAutoRemindersNotAnotherMe
	}
	if err != nil {
		return "", err
	}
	sponsor, err := queries.GetActor(ctx, store.GetActorParams{ID: auth.SponsorActorID, TenantID: auth.TenantID})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (sponsor.Kind != "human" || !sponsor.AccountID.Valid)) {
		return "", ErrNoSponsorAccount
	}
	if err != nil {
		return "", err
	}
	return sponsor.AccountID.String, nil
}
