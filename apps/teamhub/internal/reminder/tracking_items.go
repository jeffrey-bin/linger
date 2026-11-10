package reminder

// Tracking items are the Human's durable follow-up facts. Agent CLI commands
// and nightly Memory maintenance use the same transactional commands.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Tracking item errors map to invalid input, a stale revision, and a missing
// item.
var (
	ErrTrackingInvalid  = errors.New("invalid tracking item command")
	ErrTrackingConflict = errors.New("tracking item changed; read its current revision")
	ErrTrackingNotFound = errors.New("tracking item not found")
)

// TrackingOwner is the Human whose tracking items a command reads or writes.
type TrackingOwner struct{ TenantID, ActorID string }

// TrackingRoutine is a Routine that follows a tracking item and why.
type TrackingRoutine struct {
	ID      string `json:"routine_id"`
	Purpose string `json:"purpose"`
}

// TrackingFields are the writable content of a tracking item.
type TrackingFields struct {
	Kind           string     `json:"kind"`
	Content        string     `json:"content"`
	DueAt          *time.Time `json:"due_at"`
	DueText        *string    `json:"due_text"`
	SourceRef      string     `json:"source_ref"`
	SourceDate     string     `json:"source_date"`
	SourceTimezone string     `json:"source_timezone"`
}

// TrackingItem is one stored follow-up fact with the Routines that follow it.
type TrackingItem struct {
	TrackingFields
	ID        string            `json:"id"`
	Status    string            `json:"status"`
	CreatedAt time.Time         `json:"created_at"`
	UpdatedAt time.Time         `json:"updated_at"`
	Revision  int64             `json:"revision"`
	Routines  []TrackingRoutine `json:"routines"`
}

// TrackingCreate adds a tracking item; the idempotency key fixes its ID.
type TrackingCreate struct {
	TrackingFields
	IdempotencyKey string `json:"idempotency_key"`
}

// TrackingVersion names a tracking item at the revision the caller last read.
type TrackingVersion struct {
	ID               string `json:"id"`
	ExpectedRevision int64  `json:"expected_revision"`
}

// TrackingUpdate rewrites a tracking item at an expected revision.
type TrackingUpdate struct {
	TrackingFields
	TrackingVersion
	Status string `json:"status"`
}

// TrackingChanges is one batch of creates, updates, and deletes.
type TrackingChanges struct {
	Create []TrackingCreate  `json:"create"`
	Update []TrackingUpdate  `json:"update"`
	Delete []TrackingVersion `json:"delete"`
	Prune  bool              `json:"prune"`
}

// TrackingResult lists the items a batch wrote and the IDs it deleted.
type TrackingResult struct {
	Items   []TrackingItem `json:"items"`
	Deleted []string       `json:"deleted"`
}

// TrackingPage is one keyset page of tracking items.
type TrackingPage struct {
	Items      []TrackingItem `json:"items"`
	NextCursor string         `json:"next_cursor"`
}

// TrackingService runs tracking item commands in their own transactions.
type TrackingService struct{ pool *pgxpool.Pool }

// NewTrackingService returns a TrackingService backed by pool.
func NewTrackingService(pool *pgxpool.Pool) *TrackingService { return &TrackingService{pool: pool} }

func validateTrackingFields(fields TrackingFields) error {
	if fields.Kind != "todo" && fields.Kind != "question" && fields.Kind != "meeting" {
		return ErrTrackingInvalid
	}
	if strings.TrimSpace(fields.Content) == "" || utf8.RuneCountInString(fields.Content) > 200 || strings.TrimSpace(fields.SourceRef) == "" || len(fields.SourceRef) > 2048 {
		return ErrTrackingInvalid
	}
	if fields.DueText != nil && (strings.TrimSpace(*fields.DueText) == "" || utf8.RuneCountInString(*fields.DueText) > 500) {
		return ErrTrackingInvalid
	}
	if _, err := time.Parse("2006-01-02", fields.SourceDate); err != nil {
		return ErrTrackingInvalid
	}
	if fields.SourceTimezone == "" {
		return ErrTrackingInvalid
	}
	if _, err := time.LoadLocation(fields.SourceTimezone); err != nil {
		return ErrTrackingInvalid
	}
	return nil
}
func trackingStableID(owner TrackingOwner, key string) string {
	sum := sha256.Sum256([]byte(owner.TenantID + "\x00" + owner.ActorID + "\x00" + key))
	return "ti_" + hex.EncodeToString(sum[:16])
}

const trackingColumns = `i.id,i.kind,i.content,i.due_at,i.due_text,i.source_ref,
 i.source_date::text,i.source_timezone,i.status,i.created_at,i.updated_at,i.revision,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('routine_id',r.id,'purpose',r.tracking_purpose) ORDER BY r.id)
 FROM room_reminders r WHERE r.tracking_item_id=i.id), '[]'::jsonb)`

func scanTrackingItem(row pgx.Row) (TrackingItem, error) {
	var item TrackingItem
	var routines []byte
	err := row.Scan(&item.ID, &item.Kind, &item.Content, &item.DueAt, &item.DueText, &item.SourceRef, &item.SourceDate, &item.SourceTimezone, &item.Status, &item.CreatedAt, &item.UpdatedAt, &item.Revision, &routines)
	if errors.Is(err, pgx.ErrNoRows) {
		return TrackingItem{}, ErrTrackingNotFound
	}
	if err != nil {
		return TrackingItem{}, err
	}
	err = json.Unmarshal(routines, &item.Routines)
	return item, err
}

// List is keyset-paged with no per-owner total limit. includeClosed is for
// nightly reconciliation: completed facts must be seen before pruning them.
func (s *TrackingService) List(ctx context.Context, owner TrackingOwner, cursor string, limit int, includeClosed bool) (TrackingPage, error) {
	if owner.TenantID == "" || owner.ActorID == "" || limit < 1 || limit > 200 {
		return TrackingPage{}, ErrTrackingInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT `+trackingColumns+` FROM memory_index.tracking_items i
 WHERE tenant_id=$1 AND owner_actor_id=$2 AND i.id>$3
 AND ($5 OR (status='open' AND (due_at IS NULL OR due_at>=now()) AND created_at>now()-interval '3 months'))
 ORDER BY i.id LIMIT $4`, owner.TenantID, owner.ActorID, cursor, limit+1, includeClosed)
	if err != nil {
		return TrackingPage{}, err
	}
	defer rows.Close()
	page := TrackingPage{Items: []TrackingItem{}}
	for rows.Next() {
		item, e := scanTrackingItem(rows)
		if e != nil {
			return TrackingPage{}, e
		}
		page.Items = append(page.Items, item)
	}
	if err = rows.Err(); err != nil {
		return TrackingPage{}, err
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		page.NextCursor = page.Items[limit-1].ID
	}
	return page, nil
}

// Apply validates the complete batch before writing. Revisions prevent a model
// using an earlier snapshot from overwriting concurrent Agent changes.
func (s *TrackingService) Apply(ctx context.Context, owner TrackingOwner, changes TrackingChanges) (TrackingResult, error) {
	if owner.TenantID == "" || owner.ActorID == "" || len(changes.Create)+len(changes.Update)+len(changes.Delete) > 200 {
		return TrackingResult{}, ErrTrackingInvalid
	}
	seen := map[string]bool{}
	for _, item := range changes.Create {
		if err := validateTrackingFields(item.TrackingFields); err != nil {
			return TrackingResult{}, err
		}
		if strings.TrimSpace(item.IdempotencyKey) == "" || len(item.IdempotencyKey) > 200 {
			return TrackingResult{}, ErrTrackingInvalid
		}
		id := trackingStableID(owner, item.IdempotencyKey)
		if seen[id] {
			return TrackingResult{}, ErrTrackingInvalid
		}
		seen[id] = true
	}
	for _, item := range changes.Update {
		if err := validateTrackingFields(item.TrackingFields); err != nil {
			return TrackingResult{}, err
		}
		if item.ID == "" || item.ExpectedRevision < 1 || seen[item.ID] || (item.Status != "open" && item.Status != "done") {
			return TrackingResult{}, ErrTrackingInvalid
		}
		seen[item.ID] = true
	}
	for _, item := range changes.Delete {
		if item.ID == "" || item.ExpectedRevision < 1 || seen[item.ID] {
			return TrackingResult{}, ErrTrackingInvalid
		}
		seen[item.ID] = true
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TrackingResult{}, err
	}
	defer tx.Rollback(ctx)
	result := TrackingResult{Items: []TrackingItem{}, Deleted: []string{}}
	var ids []string
	for _, item := range changes.Create {
		id := trackingStableID(owner, item.IdempotencyKey)
		_, err = tx.Exec(ctx, `INSERT INTO memory_index.tracking_items
 (id,tenant_id,owner_actor_id,kind,content,due_at,due_text,source_ref,source_date,source_timezone)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10) ON CONFLICT(id) DO NOTHING`, id, owner.TenantID, owner.ActorID, item.Kind, item.Content, item.DueAt, item.DueText, item.SourceRef, item.SourceDate, item.SourceTimezone)
		if err != nil {
			return TrackingResult{}, err
		}
		ids = append(ids, id)
	}
	for _, item := range changes.Update {
		tag, e := tx.Exec(ctx, `UPDATE memory_index.tracking_items SET kind=$5,content=$6,due_at=$7,due_text=$8,
 source_ref=$9,source_date=$10::date,source_timezone=$11,status=$12,updated_at=now(),revision=revision+1
 WHERE tenant_id=$1 AND owner_actor_id=$2 AND id=$3 AND revision=$4`, owner.TenantID, owner.ActorID, item.ID, item.ExpectedRevision, item.Kind, item.Content, item.DueAt, item.DueText, item.SourceRef, item.SourceDate, item.SourceTimezone, item.Status)
		if e != nil {
			return TrackingResult{}, e
		}
		if tag.RowsAffected() != 1 {
			return TrackingResult{}, ErrTrackingConflict
		}
		ids = append(ids, item.ID)
	}
	var pruned []string
	if changes.Prune {
		rows, e := tx.Query(ctx, `SELECT id FROM memory_index.tracking_items WHERE tenant_id=$1 AND owner_actor_id=$2
 AND (status='done' OR due_at<now() OR created_at<=now()-interval '3 months') FOR UPDATE`, owner.TenantID, owner.ActorID)
		if e != nil {
			return TrackingResult{}, e
		}
		if pruned, e = pgx.CollectRows(rows, pgx.RowTo[string]); e != nil {
			return TrackingResult{}, e
		}
	}
	// The Routines serving deleted items go first, so each deletion is
	// recorded in its Room instead of cascading silently.
	deleting := append([]string{}, pruned...)
	for _, item := range changes.Delete {
		deleting = append(deleting, item.ID)
	}
	if err := DeleteTrackingItemRoutinesTx(ctx, tx, owner.TenantID, deleting); err != nil {
		return TrackingResult{}, err
	}
	for _, item := range changes.Delete {
		tag, e := tx.Exec(ctx, `DELETE FROM memory_index.tracking_items WHERE tenant_id=$1 AND owner_actor_id=$2 AND id=$3 AND revision=$4`, owner.TenantID, owner.ActorID, item.ID, item.ExpectedRevision)
		if e != nil {
			return TrackingResult{}, e
		}
		if tag.RowsAffected() != 1 {
			return TrackingResult{}, ErrTrackingConflict
		}
		result.Deleted = append(result.Deleted, item.ID)
	}
	if len(pruned) > 0 {
		rows, e := tx.Query(ctx, `DELETE FROM memory_index.tracking_items WHERE tenant_id=$1 AND owner_actor_id=$2 AND id=ANY($3) RETURNING id`, owner.TenantID, owner.ActorID, pruned)
		if e != nil {
			return TrackingResult{}, e
		}
		ids, e := pgx.CollectRows(rows, pgx.RowTo[string])
		if e != nil {
			return TrackingResult{}, e
		}
		result.Deleted = append(result.Deleted, ids...)
	}
	for _, id := range ids {
		item, e := scanTrackingItem(tx.QueryRow(ctx, `SELECT `+trackingColumns+` FROM memory_index.tracking_items i WHERE tenant_id=$1 AND owner_actor_id=$2 AND i.id=$3`, owner.TenantID, owner.ActorID, id))
		if errors.Is(e, ErrTrackingNotFound) && changes.Prune {
			continue
		}
		if e != nil {
			return TrackingResult{}, e
		}
		result.Items = append(result.Items, item)
	}
	if err = tx.Commit(ctx); err != nil {
		return TrackingResult{}, err
	}
	return result, nil
}

// Done marks one tracking item done at its expected revision.
func (s *TrackingService) Done(ctx context.Context, owner TrackingOwner, version TrackingVersion) (TrackingItem, error) {
	if version.ID == "" || version.ExpectedRevision < 1 {
		return TrackingItem{}, ErrTrackingInvalid
	}
	// One statement keeps the revision check and state transition atomic.
	return scanTrackingItem(s.pool.QueryRow(ctx, `WITH changed AS (
 UPDATE memory_index.tracking_items SET status='done',revision=revision+1,updated_at=now()
 WHERE tenant_id=$1 AND owner_actor_id=$2 AND id=$3 AND revision=$4 RETURNING *)
 SELECT `+trackingColumns+` FROM changed i`, owner.TenantID, owner.ActorID, version.ID, version.ExpectedRevision))
}
