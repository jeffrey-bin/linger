package agentruntimestate

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Service owns the durable Agent Runtime state in PostgreSQL: Contexts,
// inputs, Local Runs, Sessions, and Local Computers.
type Service struct {
	pool        *pgxpool.Pool
	onlineHooks []LocalComputerOnlineHook
}

// LocalComputerOnlineHook reacts to every observation of an online Local
// Computer: its hello, each heartbeat, and each change to its Runtimes or
// workspaces. A hook that has nothing left to do must return cheaply, and one
// that could not finish tries again on the next observation. A hook runs
// inside the transaction that records the observation, so its writes commit
// or roll back with it; an error aborts the observation.
type LocalComputerOnlineHook func(ctx context.Context, tx pgx.Tx, computer LocalComputer) error

// OnLocalComputerOnline subscribes a hook to observations of online Computers.
// Register hooks while wiring the application, before serving requests.
func (s *Service) OnLocalComputerOnline(hook LocalComputerOnlineHook) {
	s.onlineHooks = append(s.onlineHooks, hook)
}

func (s *Service) runOnlineHooks(ctx context.Context, tx pgx.Tx, row store.LocalComputer) error {
	if len(s.onlineHooks) == 0 || row.Status != "online" {
		return nil
	}
	computer, err := localComputerFromRow(row)
	if err != nil {
		return err
	}
	for _, hook := range s.onlineHooks {
		if err := hook(ctx, tx, computer); err != nil {
			return err
		}
	}
	return nil
}

// New returns a Service backed by pool.
func New(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// executeEpochTx runs one Runtime write of the current Agent Service epoch.
// The epoch row stays locked until the write commits, so a newly started
// process waits for it and then interrupts what it claimed. An earlier epoch
// is fenced.
func executeEpochTx[T any](
	ctx context.Context,
	service *Service,
	epoch string,
	operation func(context.Context, pgx.Tx, *store.Queries) (T, error),
) (T, error) {
	var zero T
	if service == nil || service.pool == nil || !validEpoch(epoch) {
		return zero, ErrInvalid
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	if _, err := queries.LockAgentServiceEpoch(ctx, epoch); err != nil {
		if isNoRows(err) {
			return zero, ErrFenced
		}
		return zero, err
	}
	result, err := operation(ctx, tx, queries)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}

// executeTx runs one Runtime state change that no epoch owns.
func executeTx[T any](
	ctx context.Context,
	service *Service,
	operation func(context.Context, pgx.Tx, *store.Queries) (T, error),
) (T, error) {
	var zero T
	if service == nil || service.pool == nil {
		return zero, ErrInvalid
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer tx.Rollback(ctx)
	result, err := operation(ctx, tx, store.New(tx))
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}

func validEpoch(epoch string) bool {
	return strings.TrimSpace(epoch) != "" && len(epoch) <= 256
}

func canonicalJSON(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil, err
	}
	if decoder.More() {
		return nil, ErrInvalid
	}
	return json.Marshal(decoded)
}

func hashJSON(value json.RawMessage) ([]byte, error) {
	canonical, err := canonicalJSON(value)
	if err != nil {
		return nil, ErrInvalid
	}
	digest := sha256.Sum256(canonical)
	return digest[:], nil
}

func newID(prefix string) (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(buffer), nil
}

func optionalText(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: value != ""}
}

func sameOptionalText(left, right pgtype.Text) bool {
	return left.Valid == right.Valid && (!left.Valid || left.String == right.String)
}

// contextRecord is the Context columns Runtime authority reads. Every query
// that reads Contexts selects exactly these, never the Runtime Session.
type contextRecord = store.GetAgentExecutionContextRow

// requireContextAuthority checks the identity a locked Context still holds:
// a Room-bound Meta Context needs its active Room membership epoch.
func requireContextAuthority(ctx context.Context, queries *store.Queries, row contextRecord) error {
	if !row.RoomID.Valid {
		return nil
	}
	if !row.MembershipEpochID.Valid {
		return ErrFenced
	}
	authorized, err := queries.IsAgentExecutionContextRoomAuthorized(ctx, store.IsAgentExecutionContextRoomAuthorizedParams{
		TenantID: row.TenantID, RoomID: row.RoomID.String,
		AgentActorID: row.AgentActorID, MembershipEpochID: row.MembershipEpochID.String,
	})
	if err != nil {
		return err
	}
	if !authorized {
		return ErrFenced
	}
	return nil
}

func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}
