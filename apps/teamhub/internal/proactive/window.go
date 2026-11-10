package proactive

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// WindowSize is how many ordinary messages of an AnotherMe direct Room the
// Agent's proactive review judges at once.
const WindowSize = 20

// ErrNotAnotherMeRoom means the Agent is not the active AnotherMe of the Room.
var ErrNotAnotherMeRoom = errors.New("not an active AnotherMe direct Room")

// ErrWindowMoved means another review advanced the window first.
var ErrWindowMoved = errors.New("conversation window already judged")

// WindowMessage is one ordinary message of a review window.
type WindowMessage struct {
	ID        string    `json:"id"`
	Author    string    `json:"author"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"created_at"`
}

// OpenItem is one current Tracking Item given to the review.
type OpenItem struct {
	ID      string     `json:"id"`
	Kind    string     `json:"kind"`
	Content string     `json:"content"`
	DueAt   *time.Time `json:"due_at,omitempty"`
}

// Window is the next unjudged window of twenty, when one is complete, with what
// the review judges it against.
type Window struct {
	JudgedCount int64           `json:"judged_count"`
	Messages    []WindowMessage `json:"messages"`
	Guideline   Guideline       `json:"guideline"`
	OpenItems   []OpenItem      `json:"open_items"`
}

// NextWindow returns the next complete window, or nil while fewer than twenty
// new messages exist. A Room seen for the first time starts after its history.
func (s *Service) NextWindow(ctx context.Context, agentManagementID, roomID string) (*Window, error) {
	queries := store.New(s.pool)
	room, err := s.anotherMeRoom(ctx, queries, agentManagementID, roomID)
	if err != nil {
		return nil, err
	}
	total, err := queries.CountRoomConversationMessages(ctx, roomID)
	if err != nil {
		return nil, err
	}
	judged, err := queries.GetConversationWindowProgress(ctx, roomID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, queries.StartConversationWindowProgress(ctx, store.StartConversationWindowProgressParams{
			RoomID: roomID, TenantID: room.TenantID, JudgedCount: total,
		})
	}
	if err != nil || total < judged+WindowSize {
		return nil, err
	}
	rows, err := queries.ListRoomConversationWindow(ctx, store.ListRoomConversationWindowParams{
		RoomID: roomID, Skip: judged, Take: WindowSize,
	})
	if err != nil || int64(len(rows)) < WindowSize {
		return nil, err
	}
	owner := Owner{TenantID: room.TenantID, ActorID: room.HumanActorID}
	guideline, err := s.guideline(ctx, owner)
	if err != nil {
		return nil, err
	}
	items, err := queries.ListProactiveTrackingItems(ctx, store.ListProactiveTrackingItemsParams{
		TenantID: owner.TenantID, OwnerActorID: owner.ActorID,
	})
	if err != nil {
		return nil, err
	}
	if guideline.Specific == nil {
		guideline.Specific = []string{}
	}
	window := &Window{JudgedCount: judged, Guideline: guideline, OpenItems: []OpenItem{}}
	for _, row := range rows {
		author := "agent"
		if row.AuthorKind == "human" {
			author = "human"
		}
		window.Messages = append(window.Messages, WindowMessage{ID: row.ID, Author: author, Text: row.Body, CreatedAt: row.CreatedAt.Time})
	}
	for _, item := range items {
		open := OpenItem{ID: item.ID, Kind: item.Kind, Content: item.Content}
		if item.DueAt.Valid {
			due := item.DueAt.Time
			open.DueAt = &due
		}
		window.OpenItems = append(window.OpenItems, open)
	}
	return window, nil
}

// FinishWindow marks the window starting at judgedCount as judged.
func (s *Service) FinishWindow(ctx context.Context, agentManagementID, roomID string, judgedCount int64) error {
	queries := store.New(s.pool)
	if _, err := s.anotherMeRoom(ctx, queries, agentManagementID, roomID); err != nil {
		return err
	}
	changed, err := queries.AdvanceConversationWindowProgress(ctx, store.AdvanceConversationWindowProgressParams{
		RoomID: roomID, JudgedCount: judgedCount + WindowSize, ExpectedJudgedCount: judgedCount,
	})
	if err == nil && changed != 1 {
		err = ErrWindowMoved
	}
	return err
}

// QueueWake queues a hidden wake for the AnotherMe, spoken by its Human. It
// goes out once the Room has been quiet for three minutes.
func (s *Service) QueueWake(ctx context.Context, agentManagementID, roomID, body string) error {
	if strings.TrimSpace(body) == "" {
		return ErrInvalidEvent
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := store.New(tx)
	room, err := s.anotherMeRoom(ctx, queries, agentManagementID, roomID)
	if err != nil {
		return err
	}
	human, err := queries.GetActor(ctx, store.GetActorParams{ID: room.HumanActorID, TenantID: room.TenantID})
	if err != nil {
		return err
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: room.AgentActorID, TenantID: room.TenantID})
	if err != nil {
		return err
	}
	if err := reminder.EnqueueTx(ctx, tx, reminder.Wake{
		Source: reminder.SourceReview, TenantID: room.TenantID, RoomID: roomID, Author: human, Agent: agent, Body: body,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// QueuePlanWake asks the Human's AnotherMe to plan Routines for the given open
// Tracking Items. Items that are gone or done are skipped; with none left, or
// without an AnotherMe Room, nothing is queued.
func (s *Service) QueuePlanWake(ctx context.Context, owner Owner, itemIDs []string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := store.New(tx)
	items, err := queries.ListOpenTrackingItemsByID(ctx, store.ListOpenTrackingItemsByIDParams{
		TenantID: owner.TenantID, OwnerActorID: owner.ActorID, Ids: itemIDs,
	})
	if err != nil || len(items) == 0 {
		return err
	}
	chat, err := queries.GetAnotherMeChat(ctx, store.GetAnotherMeChatParams{
		TenantID: owner.TenantID, HumanActorID: owner.ActorID,
	})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !chat.RoomID.Valid {
		return nil
	}
	if err != nil {
		return err
	}
	human, err := queries.GetActor(ctx, store.GetActorParams{ID: owner.ActorID, TenantID: owner.TenantID})
	if err != nil {
		return err
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: chat.AgentActorID, TenantID: owner.TenantID})
	if err != nil {
		return err
	}
	guideline, err := s.guideline(ctx, owner)
	if err != nil {
		return err
	}
	lines := []string{reminder.Prompt(reminder.NightlyPlan, nil), "<part-1>"}
	for _, rule := range guideline.Specific {
		lines = append(lines, "- "+rule)
	}
	if len(guideline.Specific) == 0 {
		lines = append(lines, "(none learned yet)")
	}
	lines = append(lines, "</part-1>", "<items>")
	for _, item := range items {
		line := "- " + item.ID + " (" + item.Kind + ") " + item.Content
		if item.DueAt.Valid {
			line += "; due: " + item.DueAt.Time.In(time.Local).Format("2006-01-02 15:04 -07:00")
		}
		if item.DueText.Valid {
			line += "; due text: " + item.DueText.String
		}
		lines = append(lines, line)
	}
	lines = append(lines, "</items>")
	if err := reminder.EnqueueTx(ctx, tx, reminder.Wake{
		Source: reminder.SourcePlan, TenantID: owner.TenantID, RoomID: chat.RoomID.String, Author: human, Agent: agent,
		Body: strings.Join(lines, "\n"),
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) anotherMeRoom(ctx context.Context, queries *store.Queries, agentManagementID, roomID string) (store.GetAnotherMeRoomForAgentRow, error) {
	room, err := queries.GetAnotherMeRoomForAgent(ctx, store.GetAnotherMeRoomForAgentParams{
		AgentManagementID: agentManagementID, RoomID: roomID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return room, ErrNotAnotherMeRoom
	}
	return room, err
}
