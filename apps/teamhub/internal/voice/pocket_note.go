package voice

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const (
	// PocketNoteDateLayout formats a Pocket Note day.
	PocketNoteDateLayout = "2006-01-02"
	// PocketNoteMaxRunes bounds a Pocket Note page.
	PocketNoteMaxRunes = 20000
	// PocketNoteDefaultLimit is the page size of a Pocket Note list.
	PocketNoteDefaultLimit = 50
)

// PocketNoteDay is the calendar day of now in TeamHub's local time zone (TZ),
// as a UTC midnight. Memory reads a day's page by the same local day.
func PocketNoteDay(now time.Time) time.Time {
	year, month, day := now.In(time.Local).Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

func pocketNoteModel(day pgtype.Date, body string, updatedAt pgtype.Timestamptz) httpapi.PocketNote {
	return httpapi.PocketNote{Date: day.Time.Format(PocketNoteDateLayout), Text: body, UpdatedAt: updatedAt.Time}
}

// ListPocketNotes lists one page of the Human's Pocket Notes before a day,
// newest first.
func (s *Service) ListPocketNotes(ctx context.Context, tenantID, ownerID string, before pgtype.Date, limit int) (httpapi.PocketNotePage, error) {
	// Read one extra row to learn whether an older page exists.
	rows, err := s.queries.ListPocketNotes(ctx, store.ListPocketNotesParams{
		TenantID: tenantID, OwnerActorID: ownerID, BeforeDate: before, RowLimit: int32(limit + 1),
	})
	if err != nil {
		return httpapi.PocketNotePage{}, err
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	items := make([]httpapi.PocketNote, 0, len(rows))
	for _, row := range rows {
		items = append(items, pocketNoteModel(row.NoteDate, row.Body, row.UpdatedAt))
	}
	page := httpapi.PageMeta{HasMore: hasMore}
	if hasMore && len(items) > 0 {
		cursor := items[len(items)-1].Date
		page.NextCursor = &cursor
	}
	return httpapi.PocketNotePage{
		Today: PocketNoteDay(time.Now()).Format(PocketNoteDateLayout),
		Items: items,
		Page:  page,
	}, nil
}

// PutTodayPocketNote replaces today's page. Clearing it deletes the row so
// the page list only ever holds days the Human actually wrote on.
func (s *Service) PutTodayPocketNote(ctx context.Context, tenantID, ownerID, text string) (httpapi.PocketNote, error) {
	day := pgtype.Date{Time: PocketNoteDay(time.Now()), Valid: true}
	if text == "" {
		err := s.writeTodayPocketNote(ctx, tenantID, ownerID, day, func(queries *store.Queries) error {
			return queries.DeletePocketNote(ctx, store.DeletePocketNoteParams{
				TenantID: tenantID, OwnerActorID: ownerID, NoteDate: day,
			})
		})
		if err != nil {
			return httpapi.PocketNote{}, fmt.Errorf("clear Pocket Note: %w", err)
		}
		return pocketNoteModel(day, "", pgtype.Timestamptz{Time: time.Now(), Valid: true}), nil
	}
	var row store.UpsertPocketNoteRow
	err := s.writeTodayPocketNote(ctx, tenantID, ownerID, day, func(queries *store.Queries) (err error) {
		row, err = queries.UpsertPocketNote(ctx, store.UpsertPocketNoteParams{
			TenantID: tenantID, OwnerActorID: ownerID, NoteDate: day, Body: text,
		})
		return err
	})
	if err != nil {
		return httpapi.PocketNote{}, fmt.Errorf("write Pocket Note: %w", err)
	}
	return pocketNoteModel(row.NoteDate, row.Body, row.UpdatedAt), nil
}

// writeTodayPocketNote changes today's page and, in the same transaction,
// schedules Tracking Items to follow it.
func (s *Service) writeTodayPocketNote(ctx context.Context, tenantID, ownerID string, day pgtype.Date, write func(*store.Queries) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := write(s.queries.WithTx(tx)); err != nil {
			return err
		}
		return enqueuePocketNoteTrackingTx(ctx, tx, tenantID, ownerID, day)
	})
}

// HidePocketNote hides a past day's page; what Memory already took in is
// kept.
func (s *Service) HidePocketNote(ctx context.Context, tenantID, ownerID string, day time.Time) error {
	return s.queries.HidePocketNote(ctx, store.HidePocketNoteParams{
		TenantID: tenantID, OwnerActorID: ownerID, NoteDate: pgtype.Date{Time: day, Valid: true},
	})
}
