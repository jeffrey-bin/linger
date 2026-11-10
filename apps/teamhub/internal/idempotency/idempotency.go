// Package idempotency replays committed command outcomes inside the caller's
// business transaction. Callers hold Lock before Lookup, and Save, Reserve or
// Complete in the same transaction as the business facts it records.
//
// A command that finishes later Reserves its key with the business state that
// starts it; Complete replaces that record with the committed outcome. A
// reserved record is unfinished work, whatever status it carries, and replay
// must not return it as the outcome.
//
// A Key whose client key is empty marks a write that callers do not
// deduplicate: Lock and Lookup find nothing, and Save, Reserve, Complete and
// DeleteReserved store nothing. A domain write shared by a deduplicated caller
// and a Human write without an Idempotency-Key passes the empty key for the
// latter.
package idempotency

import (
	"bytes"
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Key identifies one command attempt. Scope is typed, for example
// account:<id>, actor:<id>, agent:<id>, or principal:<id>.
type Key struct {
	Scope     string
	Operation string
	Key       string
}

// deduplicated reports whether k names a write that keeps a record.
func (k Key) deduplicated() bool {
	return k.Key != ""
}

// AgentKey scopes a command to the Agent actor that issued it. Actor IDs are
// globally unique, so the scope does not need the tenant.
func AgentKey(agentActorID, operation, key string) Key {
	return Key{Scope: "agent:" + agentActorID, Operation: operation, Key: key}
}

// ActorKey scopes a command to the principal actor that issued it.
func ActorKey(actorID, operation, key string) Key {
	return Key{Scope: "actor:" + actorID, Operation: operation, Key: key}
}

// AccountKey scopes a command to the account that issued it.
func AccountKey(accountID, operation, key string) Key {
	return Key{Scope: AccountScope(accountID), Operation: operation, Key: key}
}

// AccountScope is the scope of commands issued by an account.
func AccountScope(accountID string) string {
	return "account:" + accountID
}

// PrincipalKey scopes a command to the principal that issued it. Document
// Comment principals are account IDs or "agent:<management id>" values.
func PrincipalKey(principalID, operation, key string) Key {
	return Key{Scope: "principal:" + principalID, Operation: operation, Key: key}
}

// Record is the outcome that a repeated command replays.
type Record struct {
	// Reserved marks unfinished work; Status and Body are then provisional.
	Reserved   bool
	ResourceID string
	Status     int
	Body       []byte
	// InvocationID names the Agent invocation a receipt answers. Each
	// invocation has one receipt per scope; a second key fails with 23505.
	InvocationID string
	// CredentialID is the Agent credential that issued the command, kept for
	// audit; credential cleanup keeps credentials a record still names.
	CredentialID string
}

// ErrConflict reports that the key was reused with a different request hash.
var ErrConflict = errors.New("idempotency key reused with different request")

// ErrNotPending reports that Complete found no reserved record for the key.
var ErrNotPending = errors.New("idempotency record is not pending")

// Lock serializes attempts for k until tx ends.
func Lock(ctx context.Context, tx pgx.Tx, k Key) error {
	if !k.deduplicated() {
		return nil
	}
	return store.New(tx).AcquireAdvisoryTransactionLock(ctx, k.Scope+"|"+k.Operation+"|"+k.Key)
}

// Lookup returns the record stored for k. It reports ErrConflict when the key
// was stored for a different request hash.
func Lookup(ctx context.Context, db store.DBTX, k Key, hash []byte) (Record, bool, error) {
	if !k.deduplicated() {
		return Record{}, false, nil
	}
	row, err := store.New(db).GetCommandReplay(ctx, store.GetCommandReplayParams{
		Scope: k.Scope, Operation: k.Operation, Key: k.Key,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Record{}, false, nil
	}
	if err != nil {
		return Record{}, false, err
	}
	if !bytes.Equal(row.RequestHash, hash) {
		return Record{}, false, ErrConflict
	}
	return toRecord(row.State, row.ResourceID, row.ResponseStatus, row.ResponseBody, row.InvocationID), true, nil
}

// Stored returns the record of k with the request hash it was stored for.
// Workers use it to resume a reserved command without the original request.
func Stored(ctx context.Context, db store.DBTX, k Key) (Record, []byte, bool, error) {
	if !k.deduplicated() {
		return Record{}, nil, false, nil
	}
	row, err := store.New(db).GetCommandReplay(ctx, store.GetCommandReplayParams{
		Scope: k.Scope, Operation: k.Operation, Key: k.Key,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Record{}, nil, false, nil
	}
	if err != nil {
		return Record{}, nil, false, err
	}
	return toRecord(row.State, row.ResourceID, row.ResponseStatus, row.ResponseBody, row.InvocationID), row.RequestHash, true, nil
}

// LookupForUpdate is Lookup that also row-locks the record until tx ends.
func LookupForUpdate(ctx context.Context, tx pgx.Tx, k Key, hash []byte) (Record, bool, error) {
	if !k.deduplicated() {
		return Record{}, false, nil
	}
	row, err := store.New(tx).GetCommandReplayForUpdate(ctx, store.GetCommandReplayForUpdateParams{
		Scope: k.Scope, Operation: k.Operation, Key: k.Key,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Record{}, false, nil
	}
	if err != nil {
		return Record{}, false, err
	}
	if !bytes.Equal(row.RequestHash, hash) {
		return Record{}, false, ErrConflict
	}
	return toRecord(row.State, row.ResourceID, row.ResponseStatus, row.ResponseBody, row.InvocationID), true, nil
}

// Save records the committed outcome of k in tx. Empty ResourceID,
// InvocationID and CredentialID are stored as NULL.
func Save(ctx context.Context, tx pgx.Tx, k Key, hash []byte, r Record) error {
	return create(ctx, tx, k, hash, r, completed)
}

// Reserve records k in tx as unfinished work until Complete or DeleteReserved.
func Reserve(ctx context.Context, tx pgx.Tx, k Key, hash []byte, r Record) error {
	return create(ctx, tx, k, hash, r, reserved)
}

const (
	reserved  = "reserved"
	completed = "completed"
)

func create(ctx context.Context, tx pgx.Tx, k Key, hash []byte, r Record, state string) error {
	if !k.deduplicated() {
		return nil
	}
	return store.New(tx).CreateCommandReplay(ctx, store.CreateCommandReplayParams{
		Scope: k.Scope, Operation: k.Operation, Key: k.Key, RequestHash: hash, State: state,
		ResourceID:     textParam(r.ResourceID),
		ResponseStatus: pgtype.Int4{Int32: int32(r.Status), Valid: true},
		ResponseBody:   r.Body,
		InvocationID:   textParam(r.InvocationID),
		CredentialID:   textParam(r.CredentialID),
	})
}

// Complete replaces the reserved record of k in tx with its committed outcome.
// It reports ErrNotPending when k has no reserved record.
func Complete(ctx context.Context, tx pgx.Tx, k Key, r Record) error {
	if !k.deduplicated() {
		return nil
	}
	changed, err := store.New(tx).CompleteCommandReplay(ctx, store.CompleteCommandReplayParams{
		Scope: k.Scope, Operation: k.Operation, Key: k.Key,
		ResourceID:     textParam(r.ResourceID),
		ResponseStatus: int32(r.Status), ResponseBody: r.Body,
	})
	if err != nil {
		return err
	}
	if changed != 1 {
		return ErrNotPending
	}
	return nil
}

// DeleteReserved removes k in tx only while it is reserved.
// Callers use it to release a reservation whose upstream change did not apply.
func DeleteReserved(ctx context.Context, tx pgx.Tx, k Key) error {
	if !k.deduplicated() {
		return nil
	}
	return store.New(tx).DeleteReservedCommandReplay(ctx, store.DeleteReservedCommandReplayParams{
		Scope: k.Scope, Operation: k.Operation, Key: k.Key,
	})
}

func textParam(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: value != ""}
}

func toRecord(state string, resourceID pgtype.Text, status pgtype.Int4, body []byte, invocationID pgtype.Text) Record {
	return Record{
		Reserved: state == reserved, ResourceID: resourceID.String, Status: int(status.Int32), Body: body,
		InvocationID: invocationID.String,
	}
}
