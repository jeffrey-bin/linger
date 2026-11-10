package reminder

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Listener polling runs entirely on River: a maintenance sweep enqueues one
// poll job per due binding and external-queue workers do the provider reads.
// poll_cursor is a JSON object owned by each source; an empty cursor means
// bootstrap (establish position, deliver nothing).
const (
	listenerPollKind  = "listener.poll"
	listenerSweepKind = "listener.sweep"

	listenerMaxAttempts  = 4
	listenerErrorBackoff = 60 // seconds added to the interval after a failed poll
	// maxEventsPerPoll caps the events one poll routes; the rest wait in the
	// cursor for the next poll.
	maxEventsPerPoll = 25
)

type pollCursor struct {
	Grant     *GrantReference   `json:"grant,omitempty"`
	V         string            `json:"v,omitempty"`
	PageToken string            `json:"page_token,omitempty"`
	Newest    string            `json:"newest,omitempty"`
	Slack     *slackPollCursor  `json:"slack,omitempty"`
	Channels  map[string]string `json:"channels,omitempty"`
	Pending   []ListenerEvent   `json:"pending,omitempty"`
}

// Slack commits one channel page per poll so a later rate limit cannot discard
// earlier work. The channel checkpoint advances only after its last page.
type slackPollCursor struct {
	ChannelID string `json:"channel_id"`
	PageToken string `json:"page_token,omitempty"`
	Newest    string `json:"newest,omitempty"`
}

func decodePollCursor(raw pgtype.Text) pollCursor {
	var cursor pollCursor
	if raw.Valid && raw.String != "" {
		_ = json.Unmarshal([]byte(raw.String), &cursor)
	}
	return cursor
}

func (c pollCursor) encode() (pgtype.Text, error) {
	payload, err := json.Marshal(c)
	if err != nil {
		return pgtype.Text{}, err
	}
	return pgtype.Text{String: string(payload), Valid: true}, nil
}

func (c pollCursor) bootstrapped() bool {
	return c.V != "" || len(c.Channels) > 0
}

type PollArgs struct {
	BindingID string `json:"binding_id"`
}

func (PollArgs) Kind() string { return listenerPollKind }
func (PollArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueExternal, MaxAttempts: listenerMaxAttempts, UniqueOpts: jobs.UniqueUnfinished}
}

type SweepArgs struct{}

func (SweepArgs) Kind() string { return listenerSweepKind }
func (SweepArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueMaintenance, MaxAttempts: 1, UniqueOpts: jobs.UniqueUnfinished}
}

// AddListenerJobWorkers registers listener workers next to AddJobWorkers. Every
// listener Routine is AnotherMe's app listener, so router takes all new events.
// While configured reports false, the sweep enqueues no poll and a poll returns
// without calling Composio.
func AddListenerJobWorkers(workers *river.Workers, service *Service, provider *composio.Client, router EventRouter, logger *slog.Logger, configured func() bool) {
	jobs.AddWorkerWhen[PollArgs](workers, configured, &pollWorker{service: service, provider: provider, router: router, logger: logger})
	jobs.AddWorkerWhen[SweepArgs](workers, configured, &sweepWorker{service: service})
}

type sweepWorker struct {
	river.WorkerDefaults[SweepArgs]
	service *Service
}

func (*sweepWorker) Timeout(*river.Job[SweepArgs]) time.Duration { return jobs.SweepTimeout }

// Work deletes the listener Routines whose connection or grant went away, then
// enqueues one poll for every due binding of an enabled Routine.
func (w *sweepWorker) Work(ctx context.Context, job *river.Job[SweepArgs]) error {
	tx, err := w.service.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	if err := deleteInvalidListenersTx(ctx, queries); err != nil {
		return err
	}
	rows, err := queries.ListDueListenerPolls(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if !row.RoutineEnabled {
			continue
		}
		if err := jobs.InsertTx(ctx, tx, PollArgs{BindingID: row.ID}, nil); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

type pollWorker struct {
	river.WorkerDefaults[PollArgs]
	service  *Service
	provider *composio.Client
	router   EventRouter
	logger   *slog.Logger
}

// Timeout bounds provider paging and body hydration on the shared external queue.
func (*pollWorker) Timeout(*river.Job[PollArgs]) time.Duration { return 5 * time.Minute }

func (w *pollWorker) Work(ctx context.Context, job *river.Job[PollArgs]) error {
	err := w.service.pollBinding(ctx, w.provider, w.router, job.Args.BindingID)
	var failed *listenerPollFailed
	if errors.As(err, &failed) {
		// The binding already waits out its backoff; a sweep polls it again.
		w.logger.Warn("routine listener poll failed", "binding_id", job.Args.BindingID, "error", failed.cause)
		return nil
	}
	return err
}

type listenerPollFailed struct{ cause error }

func (e *listenerPollFailed) Error() string { return e.cause.Error() }
func (e *listenerPollFailed) Unwrap() error { return e.cause }

type pollRead struct {
	events   []ListenerEvent
	cursor   pollCursor
	nextPoll time.Duration
}

type pollTarget struct {
	binding    store.RoomRoutineListener
	record     store.RoomReminder
	spec       ListenerSpec
	connection store.LockGrantedConnectionForListenerRow
}

// pollBinding polls one binding of a listener Routine that still has its
// connection and grant.
func (s *Service) pollBinding(ctx context.Context, provider *composio.Client, router EventRouter, bindingID string) error {
	target, err := s.loadPollTarget(ctx, bindingID)
	if err != nil || target == nil {
		return err
	}
	interval := time.Duration(target.binding.PollIntervalSeconds) * time.Second
	if interval <= 0 {
		interval = defaultPollIntervalSec * time.Second
	}
	cursor := decodePollCursor(target.binding.PollCursor)
	grant := GrantReference{ID: target.connection.GrantID, Revision: target.connection.GrantRevision, ConnectionID: target.binding.ConnectionID, AgentActorID: target.record.MentionActorID.String, TenantID: target.binding.TenantID}
	if cursor.Grant == nil || *cursor.Grant != grant {
		cursor = pollCursor{Grant: &grant}
	}
	if !target.record.Enabled {
		// Disabled routine: hold position without fetching so resume is cheap.
		return s.advancePoll(ctx, bindingID, cursor, interval)
	}
	// Each provider request and retry checks authority without holding a DB lock over I/O.
	callCtx := composio.WithRequestAuthorization(ctx, func(ctx context.Context) error { return grant.Check(ctx, store.New(s.pool)) })
	read, err := fetchListenerPoll(callCtx, provider, target.connection.UpstreamConnectionID, target.spec, cursor)
	if err != nil {
		if derr := s.delayPoll(ctx, bindingID, pollFailureDelay(interval, err)); derr != nil {
			return derr
		}
		return &listenerPollFailed{cause: err}
	}
	read.cursor.Grant = &grant
	if read.nextPoll > 0 {
		interval = read.nextPoll
	}
	if !read.cursor.bootstrapped() {
		read.cursor = cursor // defensive: fetchers must bootstrap, never lose the old cursor
	}
	matched := read.cursor.Pending
	for _, event := range read.events {
		if MatchEvent(target.spec, event) {
			matched = append(matched, event)
		}
	}
	read.cursor.Pending = nil
	shown := matched
	if len(shown) > maxEventsPerPoll {
		shown = shown[:maxEventsPerPoll]
		read.cursor.Pending = matched[maxEventsPerPoll:]
		interval = time.Minute
	}
	for i := range shown {
		shown[i].Grant = &grant
	}
	return s.commitPoll(ctx, target.binding, target.record, read.cursor, interval, shown, router)
}

// loadPollTarget reads what one poll needs. A nil target means there is
// nothing to poll: the binding is gone, or its Routine lost its connection or
// grant and waits for the sweep to delete it.
func (s *Service) loadPollTarget(ctx context.Context, bindingID string) (*pollTarget, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	binding, err := queries.GetRoomRoutineListener(ctx, bindingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil // binding removed between enqueue and run
	}
	if err != nil {
		return nil, err
	}
	record, specs, err := routineSpecForBinding(ctx, queries, binding)
	if err != nil {
		return nil, err
	}
	connection, err := queries.LockGrantedConnectionForListener(ctx, store.LockGrantedConnectionForListenerParams{ConnectionID: binding.ConnectionID, AgentActorID: record.MentionActorID.String, TenantID: binding.TenantID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &pollTarget{binding: binding, record: record, spec: specs[binding.Ordinal], connection: connection}, nil
}

func (s *Service) advancePoll(ctx context.Context, bindingID string, cursor pollCursor, interval time.Duration) error {
	encoded, err := cursor.encode()
	if err != nil {
		return err
	}
	return store.New(s.pool).AdvanceRoutineListenerPoll(ctx, store.AdvanceRoutineListenerPollParams{
		PollCursor: encoded,
		PollNextAt: pgtype.Timestamptz{Time: time.Now().UTC().Add(interval), Valid: true},
		ID:         bindingID,
	})
}

// delayPoll keeps a failed poll's cursor and tries again after delay.
func (s *Service) delayPoll(ctx context.Context, bindingID string, delay time.Duration) error {
	return store.New(s.pool).DelayRoutineListenerPoll(ctx, store.DelayRoutineListenerPollParams{
		PollNextAt: pgtype.Timestamptz{Time: time.Now().UTC().Add(delay), Valid: true},
		ID:         bindingID,
	})
}

// commitPoll routes the new events, writes their dedup rows, and advances the
// cursor in one transaction. Nothing is routed once the Routine lost its
// connection or grant during the read.
func (s *Service) commitPoll(ctx context.Context, binding store.RoomRoutineListener, record store.RoomReminder, cursor pollCursor, interval time.Duration, shown []ListenerEvent, router EventRouter) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	if _, err := queries.GetRoomRoutineListener(ctx, binding.ID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if err := cursor.Grant.Check(ctx, queries); errors.Is(err, ErrGrantRevoked) {
		return nil
	} else if err != nil {
		return err
	}
	current, err := queries.GetRoomReminder(ctx, store.GetRoomReminderParams{ID: record.ID, RoomID: record.RoomID, TenantID: record.TenantID})
	if err != nil {
		return err
	}
	if !current.Enabled || current.MentionActorID.String != cursor.Grant.AgentActorID {
		return nil
	}

	pending := shown[:0]
	for _, event := range shown {
		if event.EventID == "" {
			pending = append(pending, event)
			continue
		}
		_, derr := queries.GetRoutineEventDelivery(ctx, store.GetRoutineEventDeliveryParams{
			RoutineID: record.ID, Source: event.Source, UpstreamEventID: event.EventID,
		})
		if errors.Is(derr, pgx.ErrNoRows) {
			pending = append(pending, event)
			continue
		}
		if derr != nil {
			return derr
		}
	}
	if len(pending) > 0 {
		if err := routeListenerEventsTx(ctx, tx, queries, record, pending, router); err != nil {
			return err
		}
	}
	encoded, err := cursor.encode()
	if err != nil {
		return err
	}
	if err := queries.AdvanceRoutineListenerPoll(ctx, store.AdvanceRoutineListenerPollParams{
		PollCursor: encoded,
		PollNextAt: pgtype.Timestamptz{Time: time.Now().UTC().Add(interval), Valid: true},
		ID:         binding.ID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func routineSpecForBinding(ctx context.Context, queries *store.Queries, binding store.RoomRoutineListener) (store.RoomReminder, []ListenerSpec, error) {
	record, err := queries.GetRoomReminder(ctx, store.GetRoomReminderParams{
		ID: binding.RoutineID, TenantID: binding.TenantID, RoomID: binding.RoomID,
	})
	if err != nil {
		return record, nil, err
	}
	var specs []ListenerSpec
	if err := json.Unmarshal(record.Trigger, &specs); err != nil {
		return record, nil, err
	}
	if int(binding.Ordinal) >= len(specs) {
		return record, nil, fmt.Errorf("listener ordinal %d out of range", binding.Ordinal)
	}
	return record, specs, nil
}

// ---- per-source fetchers -------------------------------------------------

type pollFetcher func(ctx context.Context, provider *composio.Client, connectedAccountID string, spec ListenerSpec, cursor pollCursor) (pollRead, error)

var pollFetchers = map[string]pollFetcher{
	ListenerSlack:   fetchSlack,
	ListenerGmail:   fetchGmail,
	ListenerOutlook: fetchOutlook,
	ListenerGCal:    fetchGCal,
}

// Slack: per-channel conversations.history with oldest=cursor over every
// channel the connection can see. Newly discovered channels share an observation
// boundary persisted before rotating through history, so waiting cannot lose messages.
func fetchSlack(ctx context.Context, provider *composio.Client, ca string, spec ListenerSpec, cursor pollCursor) (pollRead, error) {
	identity, err := provider.IdentifySlack(ctx, ca)
	if err != nil {
		return pollRead{}, err
	}
	observedAt := time.Now().UTC()
	channels, err := provider.ListSlackChannels(ctx, ca)
	if err != nil {
		return pollRead{}, err
	}
	if cursor.Channels == nil {
		cursor.Channels = map[string]string{}
	}
	if len(channels) == 0 {
		return pollRead{cursor: cursor}, nil
	}
	boundary := fmt.Sprintf("%d.%06d", observedAt.Unix(), observedAt.Nanosecond()/1000)
	discovered := false
	for _, channel := range channels {
		if cursor.Channels[channel.ID] == "" {
			cursor.Channels[channel.ID] = boundary
			discovered = true
		}
	}
	if discovered {
		return pollRead{cursor: cursor, nextPoll: time.Minute}, nil
	}
	sort.Slice(channels, func(i, j int) bool { return channels[i].ID < channels[j].ID })
	if cursor.Slack == nil {
		cursor.Slack = &slackPollCursor{}
	}
	index := 0
	for index < len(channels)-1 && channels[index].ID < cursor.Slack.ChannelID {
		index++
	}
	channel := channels[index]
	if channel.ID != cursor.Slack.ChannelID {
		cursor.Slack = &slackPollCursor{ChannelID: channel.ID}
	}
	oldest := cursor.Channels[channel.ID]
	page, err := provider.ListSlackChannelMessagesPage(ctx, ca, channel.ID, oldest, cursor.Slack.PageToken, 15)
	if errors.Is(err, composio.ErrSlackPageTokenInvalid) && cursor.Slack.PageToken != "" {
		// A restart may outlive Slack's continuation. Replay from the committed
		// channel checkpoint; existing event receipts suppress delivered messages.
		cursor.Slack = &slackPollCursor{ChannelID: channel.ID}
		return pollRead{cursor: cursor, nextPoll: time.Minute}, nil
	}
	if err != nil {
		return pollRead{}, err
	}
	read := pollRead{cursor: cursor}
	for _, m := range page.Messages {
		event := ListenerEvent{
			Source: ListenerSlack, EventID: channel.ID + ":" + m.Ts, EventKind: "message",
			Channel: channel.Name, ChannelID: channel.ID, Sender: m.User, Text: m.Text,
			IsMention: strings.Contains(m.Text, "<@"+identity.UserID+">"),
			MessageID: m.Ts, ThreadID: m.ThreadTs,
		}
		read.events = append(read.events, event)
	}
	cursor.Slack.Newest = max(cursor.Slack.Newest, page.Newest)
	if page.NextCursor != "" {
		cursor.Slack.PageToken = page.NextCursor
		read.nextPoll = time.Minute
	} else {
		cursor.Channels[channel.ID] = max(oldest, cursor.Slack.Newest)
		cursor.Slack = &slackPollCursor{ChannelID: channels[(index+1)%len(channels)].ID}
		interval := time.Duration(spec.PollIntervalSeconds) * time.Second
		if interval <= 0 {
			interval = defaultPollIntervalSec * time.Second
		}
		read.nextPoll = max(time.Minute, interval/time.Duration(len(channels)))
	}
	read.cursor = cursor
	return read, nil
}

// Gmail: users.history(messageAdded) from startHistoryId, hydrating each new
// message for headers. Bootstrap reads the profile historyId only.
func fetchGmail(ctx context.Context, provider *composio.Client, ca string, spec ListenerSpec, cursor pollCursor) (pollRead, error) {
	if cursor.V == "" {
		historyID, err := provider.BootstrapGmailHistoryID(ctx, ca)
		if err != nil {
			return pollRead{}, err
		}
		cursor.V = historyID
		cursor.PageToken = ""
		return pollRead{cursor: cursor}, nil
	}
	page, err := provider.ListGmailNewMessagesPage(ctx, ca, cursor.V, cursor.PageToken)
	if errors.Is(err, composio.ErrGmailPageTokenInvalid) {
		// Replay from the committed history checkpoint; event receipts deduplicate it.
		cursor.PageToken = ""
		return pollRead{cursor: cursor, nextPoll: time.Minute}, nil
	}
	if errors.Is(err, composio.ErrGmailHistoryExpired) {
		// startHistoryId aged out: re-bootstrap and take the lost window as a
		// miss; the provider cannot replay it.
		historyID, berr := provider.BootstrapGmailHistoryID(ctx, ca)
		if berr != nil {
			return pollRead{}, berr
		}
		cursor.V = historyID
		cursor.PageToken = ""
		return pollRead{cursor: cursor}, nil
	}
	if err != nil {
		return pollRead{}, err
	}
	read := pollRead{cursor: cursor}
	for _, m := range page.Messages {
		read.events = append(read.events, ListenerEvent{
			Source: ListenerGmail, EventID: m.ID, EventKind: "message",
			From: m.From, To: m.To, Subject: m.Subject, Snippet: m.Snippet,
			MessageID: m.ID, ThreadID: m.ThreadID, LabelIDs: m.LabelIDs,
		})
	}
	cursor.PageToken = page.NextPageToken
	if page.NextPageToken == "" {
		cursor.V = page.HistoryID
	} else {
		read.nextPoll = time.Minute
	}
	read.cursor = cursor
	return read, nil
}

// Outlook: Graph messages/delta. Bootstrap pages through the initial full
// sync to the deltaLink without emitting events; incremental polls report
// messages created after the listener was created.
func fetchOutlook(ctx context.Context, provider *composio.Client, ca string, spec ListenerSpec, cursor pollCursor) (pollRead, error) {
	if cursor.Channels == nil {
		cursor.Channels = map[string]string{}
	}
	if cursor.Channels["since"] == "" {
		cursor.Channels["since"] = time.Now().UTC().Format(time.RFC3339Nano)
		// Commit the boundary before any remote request can fail.
		return pollRead{cursor: cursor, nextPoll: time.Minute}, nil
	}
	link := cursor.V
	if cursor.PageToken != "" {
		link = cursor.PageToken
	}
	messages, nextLink, deltaLink, err := provider.ListOutlookMessageDelta(ctx, ca, link)
	if errors.Is(err, composio.ErrOutlookDeltaExpired) {
		// Retry a lost continuation from the committed delta; if that expires too,
		// resync from the original observation boundary. Delivery receipts dedup it.
		if cursor.PageToken != "" {
			cursor.PageToken = ""
		} else {
			cursor.V = ""
		}
		return pollRead{cursor: cursor, nextPoll: time.Minute}, nil
	}
	if err != nil {
		return pollRead{}, err
	}
	read := pollRead{cursor: cursor}
	since, err := time.Parse(time.RFC3339Nano, cursor.Channels["since"])
	if err != nil {
		return pollRead{}, err
	}
	for _, m := range messages {
		if !m.CreatedAt.After(since) {
			continue
		}
		body, found, err := provider.ReadOutlookMessageBody(ctx, ca, m.ID)
		if err != nil {
			return pollRead{}, err
		}
		if !found {
			continue
		}
		read.events = append(read.events, ListenerEvent{
			Source: ListenerOutlook, EventID: m.ID, EventKind: "message",
			From: m.From, To: m.To, Subject: m.Subject, Snippet: body,
			MessageID: m.ID,
		})
	}
	cursor.PageToken = nextLink
	if deltaLink != "" {
		cursor.V = deltaLink
	} else {
		read.nextPoll = time.Minute
	}
	read.cursor = cursor
	return read, nil
}

// GCal: events.list with updatedMin+showDeleted. Kind is derived per change:
// cancelled status wins; created==updated means a creation. Cursor advances
// to the max Updated seen so boundary events reappear once and dedup absorbs
// the repeat.
func fetchGCal(ctx context.Context, provider *composio.Client, ca string, spec ListenerSpec, cursor pollCursor) (pollRead, error) {
	calendarID := spec.CalendarID
	if calendarID == "" {
		calendarID = "primary"
	}
	if cursor.V == "" {
		cursor.V = time.Now().UTC().Format(time.RFC3339Nano)
		return pollRead{cursor: cursor}, nil
	}
	updatedMin, err := time.Parse(time.RFC3339Nano, cursor.V)
	if err != nil {
		return pollRead{}, err
	}
	changes, next, err := provider.ListGoogleCalendarChanges(ctx, ca, calendarID, updatedMin, cursor.PageToken)
	if errors.Is(err, composio.ErrCalendarPageTokenInvalid) {
		cursor.PageToken, cursor.Newest = "", ""
		return pollRead{cursor: cursor, nextPoll: time.Minute}, nil
	}
	if err != nil {
		return pollRead{}, err
	}
	read := pollRead{cursor: cursor}
	newest := updatedMin
	if cursor.Newest != "" {
		newest, err = time.Parse(time.RFC3339Nano, cursor.Newest)
		if err != nil {
			return pollRead{}, err
		}
	}
	for _, ch := range changes {
		if ch.ID == "" || (ch.Updated.IsZero() && !strings.EqualFold(ch.Status, "cancelled")) {
			return pollRead{}, errors.New("calendar change missing identity or revision")
		}
		if ch.Updated.After(newest) {
			newest = ch.Updated
		}
		kind := "updated"
		if strings.EqualFold(ch.Status, "cancelled") {
			kind = "cancelled"
		} else if !ch.Created.IsZero() && !ch.Created.Before(ch.Updated) {
			kind = "created"
		}
		revision := ch.Updated.UTC().Format(time.RFC3339Nano)
		if ch.Updated.IsZero() {
			revision = "cancelled"
		}
		read.events = append(read.events, ListenerEvent{
			Source: ListenerGCal, EventID: ch.ID + ":" + revision, EventKind: kind,
			Summary: ch.Summary, Start: ch.Start, End: ch.End,
			Description: ch.Description, Location: ch.Location, Organizer: ch.Organizer,
			MessageID: ch.ID,
		})
	}
	cursor.PageToken = next
	if next == "" {
		cursor.V = newest.UTC().Format(time.RFC3339Nano)
		cursor.Newest = ""
	} else {
		cursor.Newest = newest.UTC().Format(time.RFC3339Nano)
		read.nextPoll = time.Minute
	}
	read.cursor = cursor
	return read, nil
}

func fetchListenerPoll(ctx context.Context, provider *composio.Client, ca string, spec ListenerSpec, cursor pollCursor) (pollRead, error) {
	if len(cursor.Pending) > 0 {
		return pollRead{cursor: cursor, nextPoll: time.Minute}, nil
	}
	fetch := pollFetchers[spec.Type]
	if fetch == nil {
		return pollRead{}, fmt.Errorf("no poller for kind %q", spec.Type)
	}
	return fetch(ctx, provider, ca, spec, cursor)
}

func pollFailureDelay(interval time.Duration, cause error) time.Duration {
	var limited *composio.RateLimitError
	if errors.As(cause, &limited) {
		return max(time.Minute, limited.RetryAfter)
	}
	return interval + listenerErrorBackoff*time.Second
}
