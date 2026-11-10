package workitem

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/tenantmembership"
)

type Service struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

func (s *Service) ListForHuman(ctx context.Context, accountID, tenantID string, filter ListFilter) (Page, error) {
	if filter.Limit < 1 || filter.Limit > 200 || len(filter.Cursor) > 512 ||
		!validOptional(filter.Kind, "issue", "task") ||
		!validOptional(filter.State, "open", "in_progress", "resolved") ||
		!validOptional(filter.Priority, "low", "medium", "high", "urgent") ||
		!validOptional(filter.ExecutionStatus, "running", "waiting_for_approval", "idle", "failed", "canceled") {
		return Page{}, ErrInvalid
	}
	cursorTime, cursorID, err := decodePageCursor(filter.Cursor)
	if err != nil {
		return Page{}, ErrInvalid
	}
	queries := store.New(s.pool)
	if _, err := humanActor(ctx, queries, accountID, tenantID); err != nil {
		return Page{}, err
	}
	records, err := queries.ListWorkItemsForHuman(ctx, store.ListWorkItemsForHumanParams{
		TenantID: tenantID, AccountID: accountID, KindFilter: filter.Kind,
		StateFilter: filter.State, PriorityFilter: filter.Priority,
		ExecutionStatusFilter:   filter.ExecutionStatus,
		HasPendingControlFilter: filter.PendingControl != nil,
		PendingControlFilter:    filter.PendingControl != nil && *filter.PendingControl,
		AssigneeActorID:         filter.AssigneeActorID, OriginRoomID: filter.OriginRoomID,
		WorkRoomID: filter.WorkRoomID, IncludeArchived: filter.IncludeArchived,
		HasCursor: filter.Cursor != "", CursorUpdatedAt: pgtype.Timestamptz{Time: cursorTime, Valid: filter.Cursor != ""},
		CursorID: cursorID, PageLimit: filter.Limit + 1,
	})
	if err != nil {
		return Page{}, err
	}
	hasMore := len(records) > int(filter.Limit)
	if hasMore {
		records = records[:filter.Limit]
	}
	items, err := loadItems(ctx, queries, records)
	if err != nil {
		return Page{}, err
	}
	page := Page{Items: items, HasMore: hasMore}
	if hasMore && len(records) > 0 {
		page.NextCursor = encodePageCursor(records[len(records)-1])
	}
	return page, nil
}

func (s *Service) GetForHuman(ctx context.Context, accountID, workItemID string) (Item, error) {
	queries := store.New(s.pool)
	record, err := queries.GetWorkItemForHuman(ctx, store.GetWorkItemForHumanParams{ID: workItemID, AccountID: accountID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, ErrNotFound
	}
	if err != nil {
		return Item{}, err
	}
	items, err := loadItems(ctx, queries, []store.WorkItem{record})
	if err != nil {
		return Item{}, err
	}
	return items[0], nil
}

func (s *Service) CreateForHuman(ctx context.Context, accountID, tenantID, key string, input CreateInput) (Result[Item], error) {
	normalized, err := normalizeCreate(input)
	if err != nil {
		return Result[Item]{}, err
	}
	if normalized.Kind == "task" {
		return Result[Item]{}, ErrUnavailable
	}
	operation := "create:" + tenantID
	hash := requestHash(normalized)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Result[Item]{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	if err := tenantmembership.Lock(ctx, queries, tenantID); err != nil {
		return Result[Item]{}, err
	}
	actor, err := humanActor(ctx, queries, accountID, tenantID)
	if err != nil {
		return Result[Item]{}, err
	}
	if err := idempotency.Lock(ctx, tx, idempotency.ActorKey(actor.ID, operation, key)); err != nil {
		return Result[Item]{}, err
	}
	if replay, found, err := lookupReplay[Item](ctx, tx, actor.ID, operation, key, hash); err != nil {
		return Result[Item]{}, err
	} else if found {
		return replay, commitResult(ctx, tx, replay)
	}
	if _, err := resolveActors(ctx, queries, tenantID, normalized.ReferencedActorIDs); err != nil {
		return Result[Item]{}, err
	}
	if _, err := resolveAssignableActors(ctx, queries, tenantID, normalized.AssigneeActorIDs); err != nil {
		return Result[Item]{}, err
	}
	if err := validateOriginLink(ctx, queries, tenantID, actor.ID, normalized); err != nil {
		return Result[Item]{}, err
	}
	number, err := queries.AllocateTenantWorkItemNumber(ctx, tenantID)
	if err != nil {
		return Result[Item]{}, err
	}
	record, err := queries.CreateWorkItem(ctx, store.CreateWorkItemParams{
		ID: idgen.New("workitem"), TenantID: tenantID, Number: number, Kind: normalized.Kind,
		Title: normalized.Title, Description: normalized.Description, Priority: normalized.Priority,
		CreatedByActorID: actor.ID,
	})
	if err != nil {
		return Result[Item]{}, err
	}
	if err := createOriginLink(ctx, queries, record, actor.ID, normalized); err != nil {
		return Result[Item]{}, err
	}
	if err := createDescriptionReferences(ctx, queries, record, normalized.ReferencedActorIDs); err != nil {
		return Result[Item]{}, err
	}
	for _, actorID := range normalized.AssigneeActorIDs {
		if _, err := queries.CreateWorkItemAssignment(ctx, store.CreateWorkItemAssignmentParams{
			WorkItemID: record.ID, TenantID: tenantID, ActorID: actorID, AssignedByActorID: actor.ID,
		}); err != nil {
			return Result[Item]{}, err
		}
	}
	if err := createActivity(ctx, queries, record.ID, tenantID, "created", actor.ID, "", "", ""); err != nil {
		return Result[Item]{}, err
	}
	items, err := loadItems(ctx, queries, []store.WorkItem{record})
	if err != nil {
		return Result[Item]{}, err
	}
	result := Result[Item]{Value: items[0]}
	if err := appendChangedEvents(ctx, queries, result.Value, actor.ID); err != nil {
		return Result[Item]{}, err
	}
	if err := createReplay(ctx, tx, actor.ID, operation, key, hash, record.ID, http.StatusCreated, result.Value); err != nil {
		return Result[Item]{}, err
	}
	return result, commitResult(ctx, tx, result)
}

func humanActor(ctx context.Context, queries *store.Queries, accountID, tenantID string) (store.Actor, error) {
	actor, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{
		TenantID: tenantID, AccountID: pgtype.Text{String: accountID, Valid: accountID != ""},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.Actor{}, ErrNotFound
	}
	return actor, err
}

func resolveActors(ctx context.Context, queries *store.Queries, tenantID string, actorIDs []string) (map[string]store.Actor, error) {
	if len(actorIDs) == 0 {
		return map[string]store.Actor{}, nil
	}
	actors, err := queries.ListActorsByTenantIDs(ctx, store.ListActorsByTenantIDsParams{TenantID: tenantID, ActorIds: actorIDs})
	if err != nil {
		return nil, err
	}
	if len(actors) != len(actorIDs) {
		return nil, ErrNotFound
	}
	result := make(map[string]store.Actor, len(actors))
	for _, actor := range actors {
		result[actor.ID] = actor
	}
	return result, nil
}

func resolveAssignableActors(ctx context.Context, queries *store.Queries, tenantID string, actorIDs []string) (map[string]store.Actor, error) {
	actors, err := resolveActors(ctx, queries, tenantID, actorIDs)
	if err != nil {
		return nil, err
	}
	for _, actorID := range actorIDs {
		actor := actors[actorID]
		if actor.Kind != "human" {
			continue
		}
		_, err := queries.LockActiveTenantHumanMembership(ctx, store.LockActiveTenantHumanMembershipParams{
			TenantID: tenantID, ID: actor.ID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
	}
	return actors, nil
}

func normalizeCreate(input CreateInput) (CreateInput, error) {
	input.Title = strings.TrimSpace(input.Title)
	if input.Priority == "" {
		input.Priority = "medium"
	}
	if !validRequired(input.Kind, "issue", "task") || !validRequired(input.Priority, "low", "medium", "high", "urgent") ||
		input.Title == "" || utf8.RuneCountInString(input.Title) > 240 || utf8.RuneCountInString(input.Description) > 50000 {
		return CreateInput{}, ErrInvalid
	}
	var err error
	input.ReferencedActorIDs, err = normalizedActorIDs(input.ReferencedActorIDs)
	if err != nil {
		return CreateInput{}, err
	}
	input.AssigneeActorIDs, err = normalizedActorIDs(input.AssigneeActorIDs)
	if err != nil {
		return CreateInput{}, err
	}
	return input, nil
}

func normalizedActorIDs(ids []string) ([]string, error) {
	if len(ids) > 100 {
		return nil, ErrInvalid
	}
	result := append([]string(nil), ids...)
	for _, id := range result {
		if id == "" {
			return nil, ErrInvalid
		}
	}
	sort.Strings(result)
	for index := 1; index < len(result); index++ {
		if result[index] == result[index-1] {
			return nil, ErrInvalid
		}
	}
	return result, nil
}

type pageCursor struct {
	UpdatedAt time.Time `json:"updated_at"`
	ID        string    `json:"id"`
}

func encodePageCursor(record store.WorkItem) string {
	return encodePageCursorValue(record.UpdatedAt.Time, record.ID)
}

func encodePageCursorValue(updatedAt time.Time, id string) string {
	encoded, err := json.Marshal(pageCursor{UpdatedAt: updatedAt, ID: id})
	if err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func decodePageCursor(value string) (time.Time, string, error) {
	if value == "" {
		return time.Time{}, "", nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return time.Time{}, "", err
	}
	var cursor pageCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil || cursor.ID == "" || cursor.UpdatedAt.IsZero() {
		return time.Time{}, "", ErrInvalid
	}
	return cursor.UpdatedAt, cursor.ID, nil
}

func validRequired(value string, allowed ...string) bool {
	return validOptional(value, allowed...) && value != ""
}

func validOptional(value string, allowed ...string) bool {
	if value == "" {
		return true
	}
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func requestHash(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(encoded)
	return digest[:]
}

func lookupReplay[T any](ctx context.Context, tx pgx.Tx, actorID, operation, key string, hash []byte) (Result[T], bool, error) {
	record, found, err := idempotency.Lookup(ctx, tx, idempotency.ActorKey(actorID, operation, key), hash)
	if errors.Is(err, idempotency.ErrConflict) {
		return Result[T]{}, false, ErrIdempotencyConflict
	}
	if err != nil || !found {
		return Result[T]{}, false, err
	}
	var value T
	if len(record.Body) > 0 {
		if err := json.Unmarshal(record.Body, &value); err != nil {
			return Result[T]{}, false, err
		}
	}
	return Result[T]{Value: value, Replay: true}, true, nil
}

func createReplay(ctx context.Context, tx pgx.Tx, actorID, operation, key string, hash []byte, resourceID string, status int, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return idempotency.Save(ctx, tx, idempotency.ActorKey(actorID, operation, key), hash, idempotency.Record{
		ResourceID: resourceID, Status: status, Body: body,
	})
}

func createActivity(ctx context.Context, queries *store.Queries, workItemID, tenantID, kind, actorID, fromState, toState, targetActorID string) error {
	_, err := queries.CreateWorkItemActivity(ctx, store.CreateWorkItemActivityParams{
		ID: idgen.New("activity"), WorkItemID: workItemID, TenantID: tenantID, Kind: kind, ActorID: actorID,
		FromState: optionalText(fromState), ToState: optionalText(toState), TargetActorID: optionalText(targetActorID),
	})
	return err
}

func optionalText(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: value != ""}
}

func commitResult[T any](ctx context.Context, tx pgx.Tx, result T) error {
	return tx.Commit(ctx)
}
