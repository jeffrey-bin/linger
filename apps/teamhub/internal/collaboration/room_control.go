package collaboration

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagereaction"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func subtractRoomIDs(ids, exclude []string) []string {
	if len(ids) == 0 || len(exclude) == 0 {
		if ids == nil {
			return []string{}
		}
		return ids
	}
	skip := make(map[string]struct{}, len(exclude))
	for _, id := range exclude {
		skip[id] = struct{}{}
	}
	kept := make([]string, 0, len(ids))
	for _, id := range ids {
		if _, found := skip[id]; found {
			continue
		}
		kept = append(kept, id)
	}
	return kept
}

type roomEventEnvelope struct {
	EventID    string            `json:"event_id"`
	TenantID   string            `json:"tenant_id"`
	RoomID     string            `json:"room_id"`
	RoomSeq    int64             `json:"room_seq"`
	OccurredAt time.Time         `json:"occurred_at"`
	EventType  string            `json:"event_type"`
	Actor      *httpapi.ActorRef `json:"actor,omitempty"`
	Payload    json.RawMessage   `json:"payload"`
}

type roomEventPage struct {
	Items         []roomEventEnvelope `json:"items"`
	LatestRoomSeq int64               `json:"latest_room_seq"`
	HasMore       bool                `json:"has_more"`
}

func eventEnvelope(row store.ListRoomEventsForAccountRow) roomEventEnvelope {
	actor := httpapi.ActorRef{Id: row.ActorID, TenantId: row.TenantID, Kind: httpapi.ActorKind(row.ActorKind), DisplayName: row.ActorDisplayName}
	return roomEventEnvelope{EventID: row.EventID, TenantID: row.TenantID, RoomID: row.RoomID, RoomSeq: row.RoomSeq, OccurredAt: row.OccurredAt.Time, EventType: row.EventType, Actor: &actor, Payload: json.RawMessage(row.Payload)}
}

// PrepareRoomPresenceContexts sends context.prepare for the preparable Meta
// Contexts of the Room's recipients, limited to agentActorIDs when non-nil.
// It returns how many prepares were sent.
func (s *Service) PrepareRoomPresenceContexts(ctx context.Context, roomID string, agentActorIDs []string) (int, error) {
	// Reuse the Inbox receive predicate so Thread, Task Room and membership
	// epoch rules match the Contexts that the next message could reach.
	recipients, err := s.queries.ListRoomPresenceRecipients(ctx, roomID)
	if err != nil {
		return 0, err
	}
	keys := make([]string, 0, len(recipients))
	for _, recipient := range recipients {
		if agentActorIDs == nil || slices.Contains(agentActorIDs, recipient.AgentActorID) {
			keys = append(keys, recipient.ContextKey)
		}
	}
	if len(keys) == 0 {
		return 0, nil
	}
	keys, err = s.queries.ListPresencePreparableContextKeys(ctx, keys)
	if err != nil {
		return 0, err
	}
	sent := 0
	for _, key := range keys {
		if err := realtime.NotifyContextPrepare(ctx, s.pool, key); err != nil {
			s.logger.Warn("Room presence hint was not sent", "room_id", roomID, "error", err)
			continue
		}
		sent++
	}
	return sent, nil
}

func messageSearchRoomModel(item store.SearchTenantMessagesForAccountRow) httpapi.MessageSearchRoom {
	room := httpapi.MessageSearchRoom{Id: item.RoomID, Kind: httpapi.RoomKindRoom, Name: item.RoomName}
	switch {
	case item.IsThread:
		room.Kind = httpapi.RoomKindThread
		parentRoomID, rootMessageID := item.ParentRoomID, item.RootMessageID
		room.ParentRoomId = &parentRoomID
		room.RootMessageId = &rootMessageID
	case item.IsDirect:
		room.Kind = httpapi.RoomKindDirect
		if item.DirectPeerDisplayName != "" {
			room.Name = item.DirectPeerDisplayName
		}
	}
	return room
}

// AuthorizedRoom reads a Room the Account can see. It reports pgx.ErrNoRows
// otherwise.
func (s *Service) AuthorizedRoom(ctx context.Context, accountID, roomID string) (store.Room, error) {
	return s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(accountID)})
}

// TenantRoomActivity lists the Account's Rooms with a running or failed
// Agent Run; a Room that is running is not also reported failed.
func (s *Service) TenantRoomActivity(ctx context.Context, accountID, tenantID string) (httpapi.TenantRoomActivity, error) {
	workingIDs, err := s.queries.ListRunningRoomIDsForTenantAccount(ctx, store.ListRunningRoomIDsForTenantAccountParams{TenantID: tenantID, AccountID: accountID})
	if err != nil {
		return httpapi.TenantRoomActivity{}, internal("load Room activity", err)
	}
	failedIDs, err := s.queries.ListFailedRoomIDsForTenantAccount(ctx, store.ListFailedRoomIDsForTenantAccountParams{TenantID: tenantID, AccountID: accountID})
	if err != nil {
		return httpapi.TenantRoomActivity{}, internal("load failed Room activity", err)
	}
	return httpapi.TenantRoomActivity{
		RunningRoomIds: workingIDs,
		FailedRoomIds:  subtractRoomIDs(failedIDs, workingIDs),
	}, nil
}

// RoomRunForControl finds the Run runID names in the Room after the Account's
// Room access. It reports pgx.ErrNoRows without that access or that Run.
func (s *Service) RoomRunForControl(ctx context.Context, accountID, roomID, runID string) (store.GetRoomRunForControlRow, error) {
	room, err := s.AuthorizedRoom(ctx, accountID, roomID)
	if err != nil {
		return store.GetRoomRunForControlRow{}, err
	}
	row, err := s.queries.GetRoomRunForControl(ctx, store.GetRoomRunForControlParams{RoomID: roomID, TenantID: room.TenantID, RunID: runID})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.GetRoomRunForControlRow{}, err
	}
	if err != nil {
		return store.GetRoomRunForControlRow{}, internal("load Room execution", err)
	}
	return row, nil
}

// RoomBackgroundTasks lists the Tasks still running for this Room, for the
// indicator above the composer: what its Meta delegated and what Live started.
func (s *Service) RoomBackgroundTasks(ctx context.Context, accountID, roomID string) ([]httpapi.RoomBackgroundTask, error) {
	room, err := s.AuthorizedRoom(ctx, accountID, roomID)
	if err != nil {
		return nil, err
	}
	rows, err := s.queries.ListRoomRunningTasks(ctx, store.ListRoomRunningTasksParams{RoomID: roomID, TenantID: room.TenantID})
	if err != nil {
		return nil, internal("load Room background Tasks", err)
	}
	items := make([]httpapi.RoomBackgroundTask, 0, len(rows))
	for _, row := range rows {
		items = append(items, httpapi.RoomBackgroundTask{Id: row.ID, Title: row.Title, Requirement: row.Description, CreatedAt: row.CreatedAt.Time})
	}
	return items, nil
}

// RoomEventPage is one page of a Room's event log.
type RoomEventPage = roomEventPage

// ListRoomEvents reads the Room's events after a sequence, up to the
// watermark taken first. It reports pgx.ErrNoRows without Room access.
func (s *Service) ListRoomEvents(ctx context.Context, accountID, roomID string, after int64, limit int32) (RoomEventPage, error) {
	latest, err := s.queries.GetRoomEventWatermarkForAccount(ctx, store.GetRoomEventWatermarkForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return roomEventPage{}, err
	}
	rows, err := s.queries.ListRoomEventsForAccount(ctx, store.ListRoomEventsForAccountParams{
		RoomID: roomID, AccountID: textValue(accountID), RoomSeq: after, RoomSeq_2: latest, Limit: limit + 1,
	})
	if err != nil {
		return roomEventPage{}, internal("list room events", err)
	}
	hasMore := len(rows) > int(limit)
	if hasMore {
		rows = rows[:limit]
	}
	items := make([]roomEventEnvelope, 0, len(rows))
	for _, row := range rows {
		items = append(items, eventEnvelope(row))
	}
	return roomEventPage{Items: items, LatestRoomSeq: latest, HasMore: hasMore}, nil
}

// ListRoomMembers reads one page of a Room's members. It reports
// pgx.ErrNoRows without Room access.
func (s *Service) ListRoomMembers(ctx context.Context, accountID, roomID string, page Page) (httpapi.RoomMemberPage, error) {
	authority, err := s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.RoomMemberPage{}, err
	}
	rows, err := s.queries.ListRoomMembersForAccount(ctx, store.ListRoomMembersForAccountParams{
		AccountID: accountID, RoomID: roomID, Cursor: page.Cursor, PageLimit: page.Limit + 1,
	})
	if err != nil {
		return httpapi.RoomMemberPage{}, internal("list room members", err)
	}
	hasMore := len(rows) > int(page.Limit)
	if hasMore {
		rows = rows[:page.Limit]
	}
	items := make([]httpapi.RoomMember, 0, len(rows))
	for _, row := range rows {
		items = append(items, listRoomMemberModel(row, roomID))
	}
	nextCursor := ""
	if len(rows) > 0 {
		nextCursor = rows[len(rows)-1].ActorID
	}
	return httpapi.RoomMemberPage{Items: items, Page: pageMeta(hasMore, nextCursor), SnapshotRoomSeq: &authority.NextRoomSeq}, nil
}

// ErrMessageReactionUnsupported reports a Message kind that takes no Reactions.
var ErrMessageReactionUnsupported = errors.New("message does not support Reactions")

// MutateMessageReaction puts or removes the Human's official Reaction on a
// Message. It reports pgx.ErrNoRows without Message access.
func (s *Service) MutateMessageReaction(ctx context.Context, accountID, roomID, messageID, reactionID string, put bool) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return internal("begin Message Reaction transaction", err)
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	authority, err := queries.GetHumanMessageReactionAuthority(ctx, store.GetHumanMessageReactionAuthorityParams{
		AccountID: accountID, MessageID: messageID, RoomID: roomID,
	})
	if err != nil {
		return err
	}
	if !authority.Supported {
		return ErrMessageReactionUnsupported
	}
	err = messagereaction.Apply(ctx, queries, messagereaction.Mutation{
		TenantID: authority.TenantID, RoomID: authority.RoomID, MessageID: authority.MessageID,
		ActorID: authority.ActorID, ReactionID: reactionID, Put: put,
	})
	if errors.Is(err, messagereaction.ErrCapacity) {
		return err
	}
	if err != nil {
		return internal("apply Message Reaction", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return internal("commit Message Reaction", err)
	}
	return nil
}

// ErrAttachmentUploadNotFound reports an upload the Human cannot reach.
var ErrAttachmentUploadNotFound = errors.New("message attachment upload was not found")

// CancelMessageAttachmentUpload deletes an unattached upload of the Human in
// the Room.
func (s *Service) CancelMessageAttachmentUpload(ctx context.Context, accountID, roomID, uploadID string) error {
	room, err := s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrAttachmentUploadNotFound
		}
		return internal("authorize attachment cancellation", err)
	}
	actor, err := s.queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: room.TenantID, AccountID: textValue(accountID)})
	if err != nil {
		return internal("resolve attachment uploader", err)
	}
	credential, ok := s.verifyMessageAttachmentCredential(uploadID, room, actor.ID)
	if !ok {
		return ErrAttachmentUploadUnavailable
	}
	deleted, err := s.deleteUnattachedMessageAttachmentObject(ctx, credential.TenantID, credential.ObjectKey)
	if err != nil {
		return internal("cancel message attachment", err)
	}
	if !deleted {
		return ErrAttachmentUploadUnavailable
	}
	return nil
}

// SearchMessages finds conversation Messages whose body contains query,
// newest first, in Rooms the Account can read today. Hits carry the plain
// Message model without card, attachment or thread hydration. A search
// stopped at its statement timeout returns the database error, which
// keywordsearch.TimedOut recognizes.
func (s *Service) SearchMessages(ctx context.Context, accountID, tenantID, query string, page Page) (httpapi.MessageSearchPage, error) {
	var items []store.SearchTenantMessagesForAccountRow
	err := pgx.BeginTxFunc(ctx, s.pool, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		queries := store.New(tx)
		if err := queries.LimitSearchStatementTime(ctx); err != nil {
			return err
		}
		var err error
		items, err = queries.SearchTenantMessagesForAccount(ctx, store.SearchTenantMessagesForAccountParams{
			TenantID: tenantID, AccountID: accountID, Query: query, Cursor: page.Cursor, PageLimit: page.Limit + 1,
		})
		return err
	})
	if err != nil {
		return httpapi.MessageSearchPage{}, err
	}
	hasMore := len(items) > int(page.Limit)
	if hasMore {
		items = items[:page.Limit]
	}
	hits := make([]httpapi.MessageSearchHit, 0, len(items))
	for _, item := range items {
		author := store.Actor{
			ID: item.AuthorActorID, TenantID: item.TenantID, Kind: item.AuthorKind,
			DisplayName: item.AuthorDisplayName, AccountID: item.AuthorAccountID,
			Handle: item.AuthorHandle, CreatedAt: item.AuthorCreatedAt,
		}
		model, err := messageModel(item.ID, item.TenantID, item.RoomID, item.Body, item.Segments, item.MessageKind, item.CardContextMessageID, item.ReplyToMessageID, item.CardTitle, item.CardKind, item.CreatedAt, author)
		if err != nil {
			return httpapi.MessageSearchPage{}, internal("decode message content", err)
		}
		hits = append(hits, httpapi.MessageSearchHit{Message: model, Room: messageSearchRoomModel(item)})
	}
	lastID := ""
	if len(items) > 0 {
		lastID = items[len(items)-1].ID
	}
	return httpapi.MessageSearchPage{Items: hits, Page: pageMeta(hasMore, lastID)}, nil
}

// RoomEventEnvelope is one Room Event as the Human event stream sends it.
type RoomEventEnvelope = roomEventEnvelope

// RoomEventWatermarks returns the latest Room Event sequence of each listed
// Room the Account can read; an unreadable Room is absent.
func (s *Service) RoomEventWatermarks(ctx context.Context, accountID string, roomIDs []string) (map[string]int64, error) {
	rows, err := s.queries.ListRoomEventWatermarksForAccount(ctx, store.ListRoomEventWatermarksForAccountParams{
		RoomIds: roomIDs, AccountID: accountID,
	})
	if err != nil {
		return nil, err
	}
	latest := make(map[string]int64, len(rows))
	for _, row := range rows {
		latest[row.RoomID] = row.LatestRoomSeq
	}
	return latest, nil
}

// RoomEventsThrough reads up to limit Room Events after one sequence and
// through another that the Account can read.
func (s *Service) RoomEventsThrough(ctx context.Context, accountID, roomID string, after, through int64, limit int32) ([]RoomEventEnvelope, error) {
	rows, err := s.queries.ListRoomEventsForAccount(ctx, store.ListRoomEventsForAccountParams{
		RoomID: roomID, AccountID: textValue(accountID), RoomSeq: after, RoomSeq_2: through, Limit: limit,
	})
	if err != nil {
		return nil, err
	}
	items := make([]RoomEventEnvelope, 0, len(rows))
	for _, row := range rows {
		items = append(items, eventEnvelope(row))
	}
	return items, nil
}

// RoomTenants returns the Tenant of each listed Room that still exists.
func (s *Service) RoomTenants(ctx context.Context, roomIDs []string) (map[string]string, error) {
	rows, err := s.queries.ListRoomTenants(ctx, roomIDs)
	if err != nil {
		return nil, err
	}
	tenants := make(map[string]string, len(rows))
	for _, row := range rows {
		tenants[row.ID] = row.TenantID
	}
	return tenants, nil
}
