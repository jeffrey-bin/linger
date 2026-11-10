package voice

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/workitem"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// voiceLiveRoomProgress reports every Run still working in a Room, the latest
// finished ones and its background Tasks. The caller checked Room access.
func (s *Service) voiceLiveRoomProgress(ctx context.Context, session voicelive.Session, roomID string) (string, error) {
	now := time.Now()
	// Background Tasks the Room's Meta delegated run outside Room Runs, so
	// the report lists them the same way the Room's indicator does.
	taskRows, err := s.queries.ListRoomBackgroundTasks(ctx, store.ListRoomBackgroundTasksParams{RoomID: roomID, TenantID: session.TenantID})
	if err != nil {
		return "", err
	}
	tasks := make([]voicelive.ProgressTask, 0, len(taskRows))
	for _, row := range taskRows {
		tasks = append(tasks, voicelive.ProgressTask{Title: row.Title, Status: row.TaskExecutionStatus.String, CreatedAt: row.CreatedAt.Time})
	}
	// The report also names what finished lately, so "how is it going" still
	// has an answer once the work is done.
	rows, err := s.queries.ListVoiceLiveRoomRuns(ctx, store.ListVoiceLiveRoomRunsParams{
		TenantID: session.TenantID, RoomID: roomID, Since: pgtype.Timestamptz{Time: now.Add(-voicelive.RecentRunWindow), Valid: true},
	})
	if err != nil {
		return "", err
	}
	slices.Reverse(rows) // oldest first
	runs := make([]voicelive.ProgressRun, 0, len(rows))
	runIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		run := voicelive.ProgressRun{ID: row.RunID, Status: row.Status, Agent: row.DisplayName, CreatedAt: row.CreatedAt.Time}
		if row.FinishedAt.Valid {
			finished := row.FinishedAt.Time
			run.FinishedAt = &finished
		}
		runs = append(runs, run)
		runIDs = append(runIDs, row.RunID)
	}
	progress, err := s.queries.ListRunProgressEvents(ctx, runIDs)
	if err != nil {
		return "", err
	}
	events := make([]taskexecution.RunEvent, 0, len(progress))
	for _, row := range progress {
		events = append(events, taskexecution.RunEvent{
			RunID: row.LocalRunID, Type: row.EventType, Payload: row.Payload, At: row.CreatedAt.Time, OutputBody: row.OutputBody,
		})
	}
	report := voicelive.RoomProgress(now, runs, events)
	report["background_tasks"] = voicelive.TaskProgress(now, tasks)
	return voicelive.Output(report), nil
}

// voiceLiveProgress reports what the Room Agents are doing with the requests
// this session handed to them, or with every Run still working in the Room.
// It reads only this Room, whose membership the active session already proves.
// executeVoiceLiveTool runs one business tool with the session Human's own
// authority through existing queries and services. Invalid model input is a
// tool result, not an HTTP error, so the live model can recover by voice.
// voiceLiveDocumentLockWait bounds how long a tool call waits for another
// one on the same Document.
const voiceLiveDocumentLockWait = 30 * time.Second

// executeVoiceLiveToolInTurn runs calls that name the same Document one at a
// time, in every TeamHub process: the model often calls several tools on one
// Document at once (an edit beside a rename, two attachments), and each
// would otherwise find the Document moved under it.
func (s *Service) executeVoiceLiveToolInTurn(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var target struct {
		DocumentID string `json:"document_id"`
	}
	_ = json.Unmarshal([]byte(request.Arguments), &target)
	output, err := s.executeVoiceLiveToolOn(ctx, session, request, target.DocumentID)
	// A Document the call worked on keeps its email draft ready to send.
	var result struct {
		DocumentID string `json:"document_id"`
		Error      string `json:"error"`
	}
	if err == nil && json.Unmarshal([]byte(output), &result) == nil && result.Error == "" {
		if documentID := cmp.Or(target.DocumentID, result.DocumentID); documentID != "" {
			s.scheduleVoiceLiveDraftSync(session, request, documentID)
		}
	}
	return output, err
}

// executeVoiceLiveToolOn runs one call, holding documentID's lock if any.
func (s *Service) executeVoiceLiveToolOn(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, documentID string) (string, error) {
	if documentID == "" {
		return s.executeVoiceLiveTool(ctx, session, request)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	// The transaction holds the lock and nothing else; ending it releases it.
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	wait, cancel := context.WithTimeout(ctx, voiceLiveDocumentLockWait)
	defer cancel()
	if _, err := tx.Exec(wait, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "voice_live_document:"+documentID); err != nil {
		return "", err
	}
	return s.executeVoiceLiveTool(ctx, session, request)
}

func (s *Service) executeVoiceLiveTool(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	switch request.Name {
	case "complete_page_action":
		var result struct {
			CallID string `json:"call_id"`
			Output string `json:"output"`
		}
		if voicelive.DecodeArguments(request.Arguments, &result) != nil || result.CallID == request.CallId || len(result.Output) > 20000 || !json.Valid([]byte(result.Output)) {
			return "", voicelive.ErrInvalid
		}
		saved, err := s.queries.GetVoiceLiveToolCall(ctx, store.GetVoiceLiveToolCallParams{VoiceSessionID: session.ID, CallID: result.CallID})
		if err != nil {
			return "", err
		}
		if saved.Name != "page_action" || saved.State != "running" {
			return voicelive.ErrorOutput("operation_not_pending"), nil
		}
		var outcome struct {
			Error  string `json:"error"`
			Status string `json:"status"`
		}
		_ = json.Unmarshal([]byte(result.Output), &outcome)
		state := "completed"
		if outcome.Error == "timeout" || outcome.Error == "outcome_unknown" || outcome.Status == "outcome_unknown" {
			state = "unknown"
		}
		err = s.queries.CompleteVoiceLiveToolCall(ctx, store.CompleteVoiceLiveToolCallParams{VoiceSessionID: session.ID, CallID: result.CallID, Output: result.Output, State: state})
		return voicelive.Output(map[string]string{"status": "saved"}), err
	case voicelive.ToolSearchMessages:
		var args voicelive.SearchArguments
		if voicelive.DecodeArguments(request.Arguments, &args) != nil || !voicelive.ValidQuery(args.Query) {
			return "", voicelive.ErrInvalid
		}
		input := store.SearchVoiceLiveMessagesForAccountParams{
			AccountID: session.AccountID, TenantID: session.TenantID,
			Query: strings.ToLower(strings.TrimSpace(args.Query)), PageLimit: 8,
		}
		if !args.AllRooms {
			input.RoomID = session.RoomID
		}
		rows, err := s.queries.SearchVoiceLiveMessagesForAccount(ctx, input)
		if err != nil {
			return "", err
		}
		hits := make([]map[string]string, 0, len(rows))
		for _, row := range rows {
			room := row.RoomName
			if row.DirectPeerDisplayName != "" {
				room = row.DirectPeerDisplayName
			}
			hits = append(hits, map[string]string{
				"room_id": row.RoomID, "room": room, "author": row.AuthorDisplayName,
				"text": voicelive.Snippet(row.Body), "created_at": row.CreatedAt.Time.Format("2006-01-02 15:04"),
			})
		}
		return voicelive.Output(map[string]any{"messages": hits}), nil
	case voicelive.ToolFindRooms:
		var args voicelive.SearchArguments
		if voicelive.DecodeArguments(request.Arguments, &args) != nil || !voicelive.ValidQuery(args.Query) {
			return "", voicelive.ErrInvalid
		}
		rows, err := s.queries.FindVoiceLiveRoomsForAccount(ctx, store.FindVoiceLiveRoomsForAccountParams{
			HumanActorID: session.HumanActorID, Query: strings.TrimSpace(args.Query),
		})
		if err != nil {
			return "", err
		}
		rooms := make([]map[string]string, 0, len(rows))
		for _, row := range rows {
			rooms = append(rooms, map[string]string{"room_id": row.ID, "name": row.Name})
		}
		return voicelive.Output(map[string]any{"rooms": rooms}), nil
	case voicelive.ToolStartTask:
		return s.startVoiceLiveTask(ctx, session, request)
	case voicelive.ToolComputerBrowser:
		return s.callVoiceLiveBrowser(ctx, session, request)
	case voicelive.ToolReplyToTask:
		return s.replyToVoiceLiveTask(ctx, session, request)
	case voicelive.ToolCancelTask:
		return s.cancelVoiceLiveTask(ctx, session, request)
	case voicelive.ToolTaskFiles:
		return s.voiceLiveTaskFiles(ctx, session, request)
	case voicelive.ToolPublishTaskResult:
		return s.publishVoiceLiveTaskResult(ctx, session, request)
	case voicelive.ToolListTasks:
		return s.listVoiceLiveTasks(ctx, session, request)
	case voicelive.ToolDecideApproval:
		return s.decideVoiceLiveApproval(ctx, session, request)
	case voicelive.ToolCheckReminders:
		page, err := reminder.NewTrackingService(s.pool).List(ctx, reminder.TrackingOwner{TenantID: session.TenantID, ActorID: session.HumanActorID}, "", 100, false)
		if err != nil {
			return "", err
		}
		list := make([]map[string]string, 0, len(page.Items))
		for _, item := range page.Items {
			entry := map[string]string{"content": voicelive.Snippet(item.Content), "kind": item.Kind}
			if item.DueText != nil && *item.DueText != "" {
				entry["due"] = *item.DueText
			} else if item.DueAt != nil {
				entry["due"] = item.DueAt.In(time.Local).Format("01-02 15:04")
			}
			list = append(list, entry)
		}
		return voicelive.Output(map[string]any{"items": list}), nil
	case voicelive.ToolReadDocument:
		var args voicelive.ReadDocumentArguments
		if voicelive.DecodeArguments(request.Arguments, &args) != nil {
			return "", voicelive.ErrInvalid
		}
		return s.readVoiceLiveDocument(ctx, session, args)
	case voicelive.ToolListWorkItems:
		var args voicelive.ListWorkItemsArguments
		if voicelive.DecodeArguments(request.Arguments, &args) != nil {
			return "", voicelive.ErrInvalid
		}
		page, err := s.workItems.ListForHuman(ctx, session.AccountID, session.TenantID, workitem.ListFilter{
			Limit: 10, State: args.State,
		})
		if errors.Is(err, workitem.ErrInvalid) {
			return "", voicelive.ErrInvalid
		}
		if err != nil {
			return "", err
		}
		items := make([]map[string]any, 0, len(page.Items))
		for _, item := range page.Items {
			value := map[string]any{"number": item.Number, "kind": item.Kind, "title": item.Title, "state": item.State, "priority": item.Priority}
			if item.TaskExecution != nil {
				value["execution_status"] = item.TaskExecution.Status
			}
			items = append(items, value)
		}
		return voicelive.Output(map[string]any{"work_items": items}), nil
	case voicelive.ToolSearchDocuments:
		var args voicelive.SearchArguments
		if voicelive.DecodeArguments(request.Arguments, &args) != nil || !voicelive.ValidQuery(args.Query) {
			return "", voicelive.ErrInvalid
		}
		// Spoken names arrive as "level 8" or "Level eight": spelled variants
		// are tried while nothing matches.
		var page document.Page[document.Document]
		var err error
		for _, query := range voicelive.QueryVariants(args.Query) {
			page, err = s.documents.Search(ctx, document.SearchInput{
				AccountID: session.AccountID, TenantID: session.TenantID, Query: query, Limit: 8,
			})
			if errors.Is(err, document.ErrInvalidInput) {
				return "", voicelive.ErrInvalid
			}
			if err != nil {
				return "", err
			}
			if len(page.Items) > 0 {
				break
			}
		}
		documents := make([]map[string]string, 0, len(page.Items))
		for _, item := range page.Items {
			value := map[string]string{"document_id": item.ID, "title": item.Title}
			if item.SearchMatch != nil && item.SearchMatch.BodySnippet != "" {
				value["snippet"] = voicelive.Snippet(item.SearchMatch.BodySnippet)
			}
			documents = append(documents, value)
		}
		return voicelive.Output(map[string]any{"documents": documents}), nil
	case voicelive.ToolSendMessage:
		return s.sendVoiceLiveMessage(ctx, session, request)
	case voicelive.ToolAppendPocketNote:
		return s.appendVoiceLivePocketNote(ctx, session, request)
	case voicelive.ToolRecallMemory:
		return s.recallVoiceLiveMemory(ctx, session, request)
	case voicelive.ToolReadPocketNotes:
		return s.readVoiceLivePocketNotes(ctx, session, request, time.Now())
	case voicelive.ToolDeletePocketNote:
		return s.deleteVoiceLivePocketNote(ctx, session, request, time.Now())
	case voicelive.ToolCreateRoom:
		return s.createVoiceLiveRoom(ctx, session, request)
	case voicelive.ToolOpenEmailCanvas:
		return s.openVoiceLiveEmailCanvas(ctx, session, request)
	case voicelive.ToolEditEmailCanvas:
		return s.editVoiceLiveEmailCanvas(ctx, session, request)
	case voicelive.ToolAttachEmailFile:
		return s.attachVoiceLiveEmailFile(ctx, session, request)
	case voicelive.ToolCreateDocument, voicelive.ToolRenameDocument, voicelive.ToolEditDocument, voicelive.ToolReplaceDocumentText,
		voicelive.ToolListComments, voicelive.ToolAddComment, voicelive.ToolReplyComment, voicelive.ToolResolveComment:
		return s.runVoiceLiveDocumentTool(ctx, session, request)
	case voicelive.ToolListRoutines, voicelive.ToolCreateRoutine, voicelive.ToolChangeRoutine:
		return s.runVoiceLiveRoutineTool(ctx, session, request)
	case voicelive.ToolCreateAgent:
		return s.createVoiceLiveAgent(ctx, session, request)
	case voicelive.ToolSaveEmailDraft, voicelive.ToolSendEmailCanvas, voicelive.ToolSearchMail, voicelive.ToolReadMail,
		voicelive.ToolSearchSlack, voicelive.ToolReadSlack, voicelive.ToolSlackInbox, voicelive.ToolSendSlack,
		voicelive.ToolListCalendar, voicelive.ToolFindFreeTime:
		return s.runVoiceLiveAppTool(ctx, session, request)
	default:
		return voicelive.ErrorOutput("unknown_tool"), nil
	}
}

func (s *Service) sendVoiceLiveMessage(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.SendMessageArguments
	text := ""
	if voicelive.DecodeArguments(request.Arguments, &args) == nil {
		text = strings.TrimSpace(args.Text)
	}
	if text == "" || utf8.RuneCountInString(text) > collaboration.MaxMessageLength {
		return "", voicelive.ErrInvalid
	}
	roomID := strings.TrimSpace(args.RoomID)
	if roomID == "" {
		roomID = session.RoomID
	}
	room, err := s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(session.AccountID)})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && room.TenantID != session.TenantID {
		return voicelive.ErrorOutput("room_not_found"), nil
	}
	if err != nil {
		return "", err
	}
	label, err := s.queries.GetVoiceLiveRoomLabel(ctx, roomID)
	if err != nil {
		return "", err
	}
	prompt := voicelive.NeedsConfirmation("Will send as the user in “" + label + "”: " + text)
	// The prompt names the Room: the page may show another Room than the call's.
	if confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), prompt); err != nil || !confirmed {
		return prompt, err
	}
	var segment httpapi.MessageSegment
	if err := segment.FromTextSegment(httpapi.TextSegment{Type: "text", Content: text}); err != nil {
		return "", err
	}
	messageRequest := httpapi.MessageCreateRequest{RawMessage: text, Segments: []httpapi.MessageSegment{segment}}
	content, err := collaboration.NormalizeMessageCreateRequest(messageRequest)
	if err != nil {
		return "", voicelive.ErrInvalid
	}
	// The same confirmed send in one turn is one Message even under new call IDs.
	digest := sha256.Sum256([]byte(session.ID + "\x00" + request.TurnId + "\x00" + roomID + "\x00" + text))
	key := "voice-live-send:" + hex.EncodeToString(digest[:16])
	_, err = s.collaboration.CreateMessage(ctx, session.AccountID, roomID, messageRequest, content, key)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return voicelive.ErrorOutput("room_not_found"), nil
	case errors.Is(err, collaboration.ErrRoomParticipationLeft), errors.Is(err, collaboration.ErrDirectRoomPeerInactive):
		return voicelive.ErrorOutput("room_unavailable"), nil
	case err != nil:
		return "", err
	}
	return voicelive.Output(map[string]string{"status": "sent", "room": label}), nil
}

// appendVoiceLivePocketNote adds one line to the session Human's own Pocket
// Note for today (local day), the same page PUT /me/pocket-notes/today
// writes. Ownership comes from the live session, never from model input.
func (s *Service) appendVoiceLivePocketNote(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.AppendPocketNoteArguments
	text, when := "", ""
	if voicelive.DecodeArguments(request.Arguments, &args) == nil {
		text = strings.Join(strings.Fields(args.Text), " ")
		when = strings.Join(strings.Fields(args.Time), " ")
	}
	if text == "" || utf8.RuneCountInString(text) > 2000 || utf8.RuneCountInString(when) > 100 {
		return "", voicelive.ErrInvalid
	}
	line := text
	if when != "" && !strings.Contains(text, when) {
		line = when + " " + text
	}
	prompt := voicelive.NeedsConfirmation("Will add to today's Pocket Notes: " + line)
	if confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), prompt); err != nil || !confirmed {
		return prompt, err
	}
	day := pgtype.Date{Time: PocketNoteDay(time.Now()), Valid: true}
	rows, err := s.queries.ListPocketNotes(ctx, store.ListPocketNotesParams{
		TenantID: session.TenantID, OwnerActorID: session.HumanActorID,
		BeforeDate: pgtype.Date{Time: day.Time.AddDate(0, 0, 1), Valid: true}, RowLimit: 1,
	})
	if err != nil {
		return "", err
	}
	body := ""
	if len(rows) > 0 && rows[0].NoteDate.Time.Equal(day.Time) {
		body = rows[0].Body
	}
	entry := "- " + line
	// A retried confirmation in the same turn does not add the line twice.
	for _, existing := range strings.Split(body, "\n") {
		if strings.TrimSpace(existing) == entry {
			return voicelive.Output(map[string]string{"status": "appended", "note": line}), nil
		}
	}
	if body = strings.TrimRight(body, "\n"); body != "" {
		body += "\n"
	}
	body += entry
	if utf8.RuneCountInString(body) > PocketNoteMaxRunes {
		return voicelive.ErrorOutput("note_full"), nil
	}
	if err := s.writeTodayPocketNote(ctx, session.TenantID, session.HumanActorID, day, func(queries *store.Queries) error {
		_, err := queries.UpsertPocketNote(ctx, store.UpsertPocketNoteParams{
			TenantID: session.TenantID, OwnerActorID: session.HumanActorID, NoteDate: day, Body: body,
		})
		return err
	}); err != nil {
		return "", err
	}
	return voicelive.Output(map[string]string{"status": "appended", "note": line}), nil
}

// createVoiceLiveRoom creates a Room the way the Web Create Room dialog
// does (createRoomTx, the same name rules, owner and realtime wake), as the
// session Human. Members are spoken names resolved against the actors that
// Human can see; ambiguity goes back to the model to ask about.
func (s *Service) createVoiceLiveRoom(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.CreateRoomArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	name := strings.Join(strings.Fields(args.Name), " ")
	description := strings.TrimSpace(args.Description)
	if name == "" || len(name) > 120 || len(description) > 2000 || len(args.Members) > voicelive.MaxRoomMembers {
		return "", voicelive.ErrInvalid
	}
	var members voicelive.MemberMatch
	if len(args.Members) > 0 {
		rows, err := s.queries.ListActorsForTenantAccount(ctx, store.ListActorsForTenantAccountParams{
			AccountID: session.AccountID, TenantID: session.TenantID, PageLimit: 500,
		})
		if err != nil {
			return "", err
		}
		directory := make([]voicelive.DirectoryActor, 0, len(rows))
		for _, row := range rows {
			directory = append(directory, voicelive.DirectoryActor{ID: row.ID, Name: strings.TrimSpace(row.DisplayName), Kind: row.Kind})
		}
		members = voicelive.MatchMembers(args.Members, directory, session.HumanActorID)
		if members.Problem != nil {
			return voicelive.Output(members.Problem), nil
		}
	}
	summary := "Will create the room “" + name + "” as the user"
	if len(members.Names) > 0 {
		summary += ", adding " + strings.Join(members.Names, ", ")
	}
	prompt := voicelive.NeedsConfirmation(summary)
	if confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), prompt); err != nil || !confirmed {
		return prompt, err
	}
	input := httpapi.HumanRoomCreateRequest{Name: name}
	if description != "" {
		input.Description = &description
	}
	// The same confirmed creation in one turn is one Room even under new call IDs.
	digest := sha256.Sum256([]byte(session.ID + "\x00" + request.TurnId + "\x00" + strings.ToLower(name) + "\x00" + strings.Join(members.IDs, ",")))
	key := "voice-live-room:" + hex.EncodeToString(digest[:16])
	result, err := s.collaboration.CreateRoom(ctx, session.AccountID, session.TenantID, input, key, members.IDs...)
	switch {
	case errors.Is(err, collaboration.ErrRoomNameTaken):
		return voicelive.Output(map[string]string{"error": "room_name_taken", "name": name}), nil
	case errors.Is(err, idempotency.ErrConflict):
		return voicelive.ErrorOutput("conflict"), nil
	case errors.Is(err, roomcreation.ErrAgentUnavailable):
		return voicelive.ErrorOutput("agent_unavailable"), nil
	case errors.Is(err, roomcreation.ErrAgentSponsorRequired):
		return voicelive.ErrorOutput("agent_sponsor_required"), nil
	case errors.Is(err, roomcreation.ErrNotFound), errors.Is(err, roomcreation.ErrInvalid):
		return voicelive.ErrorOutput("member_unavailable"), nil
	case errors.Is(err, pgx.ErrNoRows):
		return voicelive.ErrorOutput("room_unavailable"), nil
	case err != nil:
		return "", err
	}
	var room httpapi.Room
	if err := json.Unmarshal(result.Body, &room); err != nil {
		return "", err
	}
	output := map[string]any{
		"status": "created", "room_id": room.Id, "room": room.Name,
		"path": "/t/" + session.TenantID + "/rooms/" + room.Id,
	}
	if len(members.Names) > 0 {
		output["members"] = members.Names
	}
	return voicelive.Output(output), nil
}

const voiceLivePocketNoteDays = 31

// readVoiceLivePocketNotes reads the Human's own Pocket Notes by local
// calendar day, the same day the notes are written under.
func (s *Service) readVoiceLivePocketNotes(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, now time.Time) (string, error) {
	var args voicelive.ReadPocketNotesArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	today := PocketNoteDay(now)
	parse := func(value string, fallback time.Time) (time.Time, bool) {
		value = strings.TrimSpace(value)
		if value == "" {
			return fallback, true
		}
		day, err := time.Parse(PocketNoteDateLayout, value)
		return day, err == nil
	}
	to, okTo := parse(args.DateTo, today)
	from, okFrom := parse(args.DateFrom, to.AddDate(0, 0, -6))
	// Only a start day asks about that one day.
	if strings.TrimSpace(args.DateTo) == "" && strings.TrimSpace(args.DateFrom) != "" {
		to = from
	}
	if !okTo || !okFrom || to.Before(from) || to.Sub(from) > voiceLivePocketNoteDays*24*time.Hour {
		return "", voicelive.ErrInvalid
	}
	rows, err := s.queries.ListPocketNotes(ctx, store.ListPocketNotesParams{
		TenantID: session.TenantID, OwnerActorID: session.HumanActorID,
		BeforeDate: pgtype.Date{Time: to.AddDate(0, 0, 1), Valid: true}, RowLimit: voiceLivePocketNoteDays + 1,
	})
	if err != nil {
		return "", err
	}
	notes := make([]map[string]string, 0, len(rows))
	for _, row := range rows {
		day := row.NoteDate.Time
		if day.Before(from) || strings.TrimSpace(row.Body) == "" {
			continue
		}
		note := map[string]string{"date": day.Format(PocketNoteDateLayout), "text": voicelive.Snippet(row.Body)}
		if relative := pocketNoteRelative(today, day); relative != "" {
			note["relative"] = relative
		}
		notes = append(notes, note)
	}
	return voicelive.Output(map[string]any{
		"today":     today.Format(PocketNoteDateLayout),
		"now_local": now.In(time.Local).Format("2006-01-02 15:04"),
		"date_from": from.Format(PocketNoteDateLayout),
		"date_to":   to.Format(PocketNoteDateLayout),
		"notes":     notes,
	}), nil
}

// deleteVoiceLivePocketNote hides one past day's page of the session Human's
// own Pocket Notes, as DELETE /me/pocket-notes/{date} does. The page is read
// back first so the model can say what will be deleted before confirming.
func (s *Service) deleteVoiceLivePocketNote(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, now time.Time) (string, error) {
	var args voicelive.DeletePocketNoteArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	day, err := time.Parse(PocketNoteDateLayout, strings.TrimSpace(args.Date))
	if err != nil {
		return "", voicelive.ErrInvalid
	}
	if !day.Before(PocketNoteDay(now)) {
		return voicelive.ErrorOutput("today_not_deletable"), nil
	}
	date := pgtype.Date{Time: day, Valid: true}
	rows, err := s.queries.ListPocketNotes(ctx, store.ListPocketNotesParams{
		TenantID: session.TenantID, OwnerActorID: session.HumanActorID,
		BeforeDate: pgtype.Date{Time: day.AddDate(0, 0, 1), Valid: true}, RowLimit: 1,
	})
	if err != nil {
		return "", err
	}
	if len(rows) == 0 || !rows[0].NoteDate.Time.Equal(day) {
		return voicelive.ErrorOutput("not_found"), nil
	}
	label := day.Format(PocketNoteDateLayout)
	prompt := voicelive.NeedsConfirmation("Will delete the Pocket Notes of " + label + ": " + voicelive.Snippet(rows[0].Body))
	if confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), prompt); err != nil || !confirmed {
		return prompt, err
	}
	if err := s.queries.HidePocketNote(ctx, store.HidePocketNoteParams{
		TenantID: session.TenantID, OwnerActorID: session.HumanActorID, NoteDate: date,
	}); err != nil {
		return "", err
	}
	return voicelive.Output(map[string]string{"status": "deleted", "date": label}), nil
}

func pocketNoteRelative(today, day time.Time) string {
	switch int(today.Sub(day).Hours() / 24) {
	case 0:
		return "today"
	case 1:
		return "yesterday"
	case 2:
		return "day_before"
	}
	return ""
}

// recallVoiceLiveMemory answers "what did I say / decide before" from the
// Human's personal memory through the same Memory query the Agent CLI
// knowledge search uses: one search over every source of the Human's
// AnotherMe index, Wiki pages and reports included, scoped to the session
// Human as owner. Model time bounds are a soft ranking window there, as for
// Agents.
func (s *Service) recallVoiceLiveMemory(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.RecallArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil || !voicelive.ValidQuery(args.Query) {
		return "", voicelive.ErrInvalid
	}
	body := map[string]any{"query": strings.TrimSpace(args.Query)}
	for key, value := range map[string]string{"event_from": args.EventFrom, "event_to": args.EventTo} {
		if value = strings.TrimSpace(value); value != "" {
			if _, err := time.Parse("2006-01-02", value); err == nil {
				body[key] = value
			}
		}
	}
	if from, to := body["event_from"], body["event_to"]; from != nil && to != nil && from.(string) > to.(string) {
		delete(body, "event_from")
		delete(body, "event_to")
	}
	// Memory indexes a day overnight: today's Pocket Note and Messages are read directly.
	now := time.Now()
	var today map[string]any
	from, _ := body["event_from"].(string)
	to, _ := body["event_to"].(string)
	if voicelive.AsksAboutToday(from, to, PocketNoteDay(now).Format(PocketNoteDateLayout)) {
		var err error
		if today, err = s.voiceLiveToday(ctx, session, now); err != nil {
			return "", err
		}
	}
	unavailable := func() string {
		if today == nil {
			return voicelive.ErrorOutput("memory_unavailable")
		}
		return voicelive.Output(map[string]any{"error": "memory_unavailable", "today": today})
	}
	if s.memory == nil {
		return unavailable(), nil
	}
	registration, err := s.queries.GetAnotherMeRegistration(ctx, store.GetAnotherMeRegistrationParams{
		TenantID: session.TenantID, RepresentedHumanActorID: session.HumanActorID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return unavailable(), nil
	}
	if err != nil {
		return "", err
	}
	// The same owner check the Agent knowledge tool applies to its source.
	if !registration.UserArtifactOwnerActorID.Valid || registration.UserArtifactOwnerActorID.String != session.HumanActorID ||
		!registration.AgentManagementID.Valid || registration.Status != "active" {
		return unavailable(), nil
	}
	body["tenant_id"] = session.TenantID
	body["user_artifact_owner_actor_id"] = session.HumanActorID
	body["agent_id"] = registration.AgentManagementID.String
	body["agent_actor_id"] = registration.ActorID
	// The live model is waiting by voice: well under the Agent CLI's 120s.
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	// The same request the Agent CLI knowledge search sends. Names it
	// contains only rank evidence about those people first.
	query := body["query"].(string)
	entities := voicelive.NamedPeople(query, s.voiceLiveDirectoryNames(ctx, session))
	raw := func(query string) (voicelive.RecallMemoryResponse, bool) {
		request := maps.Clone(body)
		request["query"] = query
		encoded, _ := json.Marshal(request)
		status, response, err := s.memory.Knowledge(ctx, "search_knowledge", encoded)
		var result voicelive.RecallMemoryResponse
		if err != nil || status != http.StatusOK || json.Unmarshal(response, &result) != nil {
			return result, false
		}
		return result, true
	}
	evidence := voicelive.RecallEvidence{Entities: entities}
	result, ok := raw(query)
	evidence.Raw = result
	// As the Agent policy says, search again before concluding: the Memory
	// query embedding has a 1s budget and falls back to keywords alone when
	// it runs over, which misses a misheard name. The second attempt uses
	// the names alone when the query names people nobody's evidence mentions.
	// Voice Runtime gives a tool 15s: retry only while a second query (up to
	// 3s embedding plus search) still fits inside this call's 12s.
	if time.Since(started) < recallRetryBefore && (len(evidence.Raw.Items) == 0 && len(evidence.Raw.Facts) == 0 || len(entities) > 0 && !voicelive.RecallMentions(evidence)) {
		again := query
		if len(entities) > 0 {
			again = strings.Join(entities, " ")
		}
		if retry, retried := raw(again); retried && (len(retry.Items) > 0 || len(retry.Facts) > 0) {
			evidence.Raw, ok = retry, true
		}
	}
	if !ok {
		return unavailable(), nil
	}
	output := voicelive.CompactRecall(evidence, func(roomID string) (string, bool) {
		room, err := s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(session.AccountID)})
		if err != nil || room.TenantID != session.TenantID {
			return "", false
		}
		// A Task's working Room is not offered: its results are in the
		// Room it came from.
		if taskRoom, err := s.queries.IsVoiceLiveTaskWorkRoom(ctx, roomID); err != nil || taskRoom {
			return "", false
		}
		return room.Name, true
	})
	output["query"] = query
	if today != nil {
		output["today"] = today
	}
	return voicelive.Output(output), nil
}

// readVoiceLiveDocument reads one Document the Human can read: the given one,
// the best match for a name, or the one shared last in this Room.
func (s *Service) readVoiceLiveDocument(ctx context.Context, session voicelive.Session, args voicelive.ReadDocumentArguments) (string, error) {
	documentID := strings.TrimSpace(args.DocumentID)
	query := strings.TrimSpace(args.Query)
	// A Document shown in this Room, such as an Agent's canvas draft, is read
	// as the Room shows it, even when it is not in the Human's library.
	shared, err := s.queries.ListVoiceLiveRoomDocuments(ctx, store.ListVoiceLiveRoomDocumentsParams{
		RoomID: session.RoomID, TenantID: session.TenantID,
	})
	if err != nil {
		return "", err
	}
	if row, ok := voiceLiveRoomDocument(shared, documentID, query); ok {
		return s.voiceLiveDocumentOutput(ctx, row.DocumentID, row.Title, row.UpdatedAt.Time, row.BodyText)
	}
	switch {
	case documentID != "":
	case query != "":
		if !voicelive.ValidQuery(query) {
			return "", voicelive.ErrInvalid
		}
		for _, variant := range voicelive.QueryVariants(query) {
			page, err := s.documents.Search(ctx, document.SearchInput{
				AccountID: session.AccountID, TenantID: session.TenantID, Query: variant, Limit: 1,
			})
			if err != nil && !errors.Is(err, document.ErrInvalidInput) {
				return "", err
			}
			if len(page.Items) > 0 {
				documentID = page.Items[0].ID
				break
			}
		}
	}
	if documentID == "" {
		return voicelive.ErrorOutput("document_not_found"), nil
	}
	value, text, err := s.documents.ReadText(ctx, session.AccountID, documentID)
	if errors.Is(err, document.ErrNotFound) || errors.Is(err, document.ErrInvalidInput) {
		return voicelive.ErrorOutput("document_not_found"), nil
	}
	if err != nil {
		return "", err
	}
	return s.voiceLiveDocumentOutput(ctx, value.ID, value.Title, value.UpdatedAt, text)
}

func (s *Service) voiceLiveDocumentOutput(ctx context.Context, documentID, title string, updatedAt time.Time, text string) (string, error) {
	result := map[string]any{
		"document_id": documentID, "title": title,
		"updated_at": updatedAt.In(time.Local).Format("2006-01-02 15:04"),
	}
	// The live model hears no pictures: it learns which images there are, by name.
	images, err := s.queries.ListVoiceLiveDocumentImages(ctx, documentID)
	if err != nil {
		return "", err
	}
	if len(images) > 0 {
		result["images"] = images
	}
	if strings.TrimSpace(text) == "" {
		result["text_pending"] = true
		return voicelive.Output(result), nil
	}
	result["text"], result["truncated"] = voicelive.Truncate(text, voicelive.MaxDocumentRunes)
	return voicelive.Output(result), nil
}

// voiceLiveRoomDocument picks the Room Document the live model asked for: by
// id, by a title it heard, or with neither, the one shared last.
func voiceLiveRoomDocument(rows []store.ListVoiceLiveRoomDocumentsRow, documentID, query string) (store.ListVoiceLiveRoomDocumentsRow, bool) {
	if len(rows) == 0 {
		return store.ListVoiceLiveRoomDocumentsRow{}, false
	}
	if documentID != "" {
		for _, row := range rows {
			if row.DocumentID == documentID {
				return row, true
			}
		}
		return store.ListVoiceLiveRoomDocumentsRow{}, false
	}
	if query == "" {
		latest := rows[0]
		for _, row := range rows[1:] {
			if row.SharedAt.Time.After(latest.SharedAt.Time) {
				latest = row
			}
		}
		return latest, true
	}
	compact := func(value string) string { return strings.ToLower(strings.Join(strings.Fields(value), "")) }
	heard := compact(query)
	for _, row := range rows {
		title := compact(row.Title)
		if title != "" && (strings.Contains(title, heard) || strings.Contains(heard, title)) {
			return row, true
		}
	}
	return store.ListVoiceLiveRoomDocumentsRow{}, false
}

// voiceLiveToday is what Memory has not indexed yet about today: the Human's
// Pocket Note page and the latest Messages in their Rooms.
func (s *Service) voiceLiveToday(ctx context.Context, session voicelive.Session, now time.Time) (map[string]any, error) {
	day := PocketNoteDay(now)
	notes, err := s.queries.ListPocketNotes(ctx, store.ListPocketNotesParams{
		TenantID: session.TenantID, OwnerActorID: session.HumanActorID,
		BeforeDate: pgtype.Date{Time: day.AddDate(0, 0, 1), Valid: true}, RowLimit: 1,
	})
	if err != nil {
		return nil, err
	}
	note := ""
	if len(notes) == 1 && notes[0].NoteDate.Time.Equal(day) {
		note = notes[0].Body
	}
	local := now.In(time.Local)
	midnight := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.Local)
	rows, err := s.queries.ListVoiceLiveTodayMessages(ctx, store.ListVoiceLiveTodayMessagesParams{
		HumanActorID: session.HumanActorID, TenantID: session.TenantID, Since: pgtype.Timestamptz{Time: midnight, Valid: true},
	})
	if err != nil {
		return nil, err
	}
	messages := make([]voicelive.TodayMessage, 0, len(rows))
	for _, row := range rows {
		room := row.RoomName
		if row.DirectPeer != "" {
			room = row.DirectPeer
		}
		messages = append(messages, voicelive.TodayMessage{Room: room, Author: row.Author, Text: row.Body, At: row.CreatedAt.Time})
	}
	return voicelive.TodayDigest(day.Format(PocketNoteDateLayout), note, messages, time.Local), nil
}

// recallRetryBefore is how late a recall may still search a second time.
const recallRetryBefore = 5 * time.Second

// voiceLiveDirectoryNames lists the display names of the people and Agents
// the session Human can see in the Tenant.
func (s *Service) voiceLiveDirectoryNames(ctx context.Context, session voicelive.Session) []string {
	rows, err := s.queries.ListActorsForTenantAccount(ctx, store.ListActorsForTenantAccountParams{
		AccountID: session.AccountID, TenantID: session.TenantID, PageLimit: 500,
	})
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		names = append(names, strings.TrimSpace(row.DisplayName))
	}
	return names
}

// voiceLiveConfirmed admits a write the model marks confirmed only when the
// user heard exactly this prompt in an earlier turn of the call, minutes
// ago, and uses that confirmation up. Otherwise the prompt is recorded as
// asked, so the user's yes in a later turn can confirm it.
func (s *Service) voiceLiveConfirmed(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, confirmed bool, prompt string) (bool, error) {
	digest := sha256.Sum256([]byte(prompt))
	hash := hex.EncodeToString(digest[:])
	if confirmed {
		used, err := s.queries.UseVoiceLiveConfirmationFor(ctx, store.UseVoiceLiveConfirmationForParams{
			VoiceSessionID: session.ID, Tool: request.Name, ArgumentsHash: hash, TurnID: request.TurnId,
			Since: pgtype.Timestamptz{Time: time.Now().Add(-voicelive.ConfirmationValidFor), Valid: true},
		})
		if err != nil || used > 0 {
			return used > 0, err
		}
	}
	return false, s.queries.CreateVoiceLiveConfirmation(ctx, store.CreateVoiceLiveConfirmationParams{
		ID: idgen.New("confirm"), VoiceSessionID: session.ID, TurnID: request.TurnId, Tool: request.Name, ArgumentsHash: hash,
	})
}

// voiceLiveCallDocuments names the Documents this call's tools worked on,
// for a provider session that starts over within the call.
func (s *Service) voiceLiveCallDocuments(ctx context.Context, session voicelive.Session) ([]voicelive.CallDocument, error) {
	rows, err := s.queries.ListVoiceLiveRecentToolCalls(ctx, session.ID)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	calls := make([]voicelive.ToolCallRecord, 0, len(rows))
	for _, row := range rows {
		calls = append(calls, voicelive.ToolCallRecord{Name: row.Name, Arguments: row.Arguments, Output: row.Output})
	}
	documents := voicelive.CallDocuments(calls)
	ids := make([]string, 0, len(documents))
	for _, document := range documents {
		ids = append(ids, document.ID)
	}
	titles, err := s.queries.ListVoiceLiveDocumentTitles(ctx, store.ListVoiceLiveDocumentTitlesParams{DocumentIds: ids, TenantID: session.TenantID})
	if err != nil {
		return nil, err
	}
	byID := map[string]string{}
	for _, title := range titles {
		byID[title.DocumentID] = title.Title
	}
	// A Document gone since, or not this tenant's, is left out.
	kept := documents[:0]
	for _, document := range documents {
		if title, ok := byID[document.ID]; ok {
			document.Title = title
			kept = append(kept, document)
		}
	}
	return kept, nil
}

// LiveContext is what the live voice starts a VoiceSession's foreground
// with: the Agent's instructions, the conversation so far, and its tools.
// connectedApps adds the tools that need connected apps.
func (s *Service) LiveContext(ctx context.Context, voiceSessionID string, connectedApps bool) (teamhubinternal.VoiceLiveContext, error) {
	session, err := voicelive.ActiveSession(ctx, s.queries, voiceSessionID)
	if err != nil {
		return teamhubinternal.VoiceLiveContext{}, err
	}
	history, err := voicelive.LoadHistory(ctx, s.queries, session)
	if err != nil {
		return teamhubinternal.VoiceLiveContext{}, err
	}
	roomLabel, err := s.queries.GetVoiceLiveRoomLabel(ctx, session.RoomID)
	if err != nil {
		return teamhubinternal.VoiceLiveContext{}, fmt.Errorf("read live Voice Room: %w", err)
	}
	user, err := s.queries.GetVoiceLiveUserMemory(ctx, store.GetVoiceLiveUserMemoryParams{ActorID: session.HumanActorID, TenantID: session.TenantID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return teamhubinternal.VoiceLiveContext{}, fmt.Errorf("read live Voice user memory: %w", err)
	}
	documents, err := s.voiceLiveCallDocuments(ctx, session)
	if err != nil {
		return teamhubinternal.VoiceLiveContext{}, fmt.Errorf("read live call Documents: %w", err)
	}
	response := teamhubinternal.VoiceLiveContext{
		RoomId: session.RoomID, AgentName: session.Agent.DisplayName,
		Instructions: voicelive.Instructions(session.Agent.DisplayName, roomLabel, voicelive.UserMemory{
			Name: user.DisplayName, Markdown: user.Markdown,
		}) + voicelive.CallDocumentsNote(documents),
		History: make([]teamhubinternal.VoiceLiveContextMessage, 0, len(history)),
		Tools:   make([]teamhubinternal.VoiceLiveTool, 0, len(voicelive.Tools)),
	}
	for _, message := range history {
		response.History = append(response.History, teamhubinternal.VoiceLiveContextMessage{
			Role: teamhubinternal.VoiceLiveContextMessageRole(message.Role), Text: message.Text,
		})
	}
	tools := voicelive.Tools
	if _, _, ok, err := s.voiceLiveBrowserTarget(ctx, session); err != nil {
		return teamhubinternal.VoiceLiveContext{}, fmt.Errorf("read live local browser: %w", err)
	} else if ok {
		tools = append(slices.Clip(tools), voicelive.BrowserTool)
	}
	// Mail, Slack and calendar need connected apps, which a deployment may
	// not have set up.
	if connectedApps {
		tools = append(slices.Clip(tools), voicelive.AppTools...)
	}
	for _, tool := range tools {
		response.Tools = append(response.Tools, teamhubinternal.VoiceLiveTool{
			Name: tool.Name, Description: tool.Description, Parameters: tool.Parameters,
		})
	}
	return response, nil
}

// SaveLiveReply records the live voice's spoken reply as the Agent's Message.
func (s *Service) SaveLiveReply(ctx context.Context, request teamhubinternal.VoiceLiveReply) (voicelive.ReplyResult, error) {
	return voicelive.SaveReply(ctx, s.pool, request.VoiceSessionId, request.EventId, request.TurnId, request.Text)
}

// ErrCallIDConflict reports a live tool call ID reused with other arguments.
var ErrCallIDConflict = errors.New("operation identity was reused for different arguments")

// ExecuteLiveToolCall admits one live tool call once per call ID and runs it.
// A repeated call returns the stored output. An operation whose outcome is
// unknown is recorded so the next foreground can read it.
func (s *Service) ExecuteLiveToolCall(ctx context.Context, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	session, err := voicelive.ActiveSession(ctx, s.queries, request.VoiceSessionId)
	if err != nil {
		return "", err
	}
	switching, err := s.queries.VoiceLiveForegroundSwitching(ctx, store.VoiceLiveForegroundSwitchingParams{
		AgentActorID: session.Agent.ID, TenantID: session.TenantID,
	})
	if err != nil {
		return "", fmt.Errorf("check foreground transition: %w", err)
	}
	if switching && request.Name != "list_tasks" && request.Name != "recall_memory" && request.Name != "read_document" {
		return voicelive.Output(map[string]string{"status": "switching", "detail": "The previous foreground is stopping. This operation was not accepted; retry after the transition."}), nil
	}
	digest := sha256.Sum256([]byte(request.TurnId + "\x00" + request.Name + "\x00" + request.Arguments))
	hash := hex.EncodeToString(digest[:])
	claimed, err := s.queries.ClaimVoiceLiveToolCall(ctx, store.ClaimVoiceLiveToolCallParams{
		VoiceSessionID: session.ID, CallID: request.CallId, TurnID: request.TurnId, Name: request.Name, Arguments: request.Arguments, RequestHash: hash,
	})
	if err != nil {
		return "", fmt.Errorf("admit live tool: %w", err)
	}
	if claimed == 0 {
		stored, err := s.queries.GetVoiceLiveToolCall(ctx, store.GetVoiceLiveToolCallParams{VoiceSessionID: session.ID, CallID: request.CallId})
		if errors.Is(err, pgx.ErrNoRows) {
			return "", voicelive.ErrNotFound
		}
		if err != nil {
			return "", fmt.Errorf("read live tool: %w", err)
		}
		if stored.RequestHash != hash {
			return "", ErrCallIDConflict
		}
		return stored.Output, nil
	}
	if request.Name == "page_action" {
		if refused, err := s.refuseTaskRoomVisit(ctx, request.Arguments); err != nil || refused != "" {
			return refused, err
		}
		return voicelive.Output(map[string]string{"status": "admitted"}), nil
	}
	output, callErr := s.executeVoiceLiveToolInTurn(ctx, session, request)
	if errors.Is(callErr, voicelive.ErrInvalid) {
		output, callErr = voicelive.ErrorOutput("invalid_arguments"), nil
	}
	state := "completed"
	var outcome struct {
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	_ = json.Unmarshal([]byte(output), &outcome)
	if outcome.Status == "needs_confirmation" && callErr == nil {
		if waiting, err := s.answeredForUser(ctx, session, request); err != nil {
			callErr = err
		} else if waiting {
			output = voicelive.AwaitingAnswer()
		}
	}
	if outcome.Status == "outcome_unknown" || outcome.Error == "outcome_unknown" {
		state = "unknown"
	}
	if callErr != nil {
		// The model only hears that the outcome is unknown; the cause is here.
		if s.logger != nil {
			s.logger.ErrorContext(ctx, "live tool call failed", "voice_session_id", session.ID, "tool", request.Name, "call_id", request.CallId, "error", callErr)
		}
		state = "unknown"
		output = voicelive.Output(map[string]string{"status": "outcome_unknown", "operation_id": request.CallId, "detail": "The operation was accepted but its outcome is unconfirmed. Check its effect before trying again."})
	}
	// A switched or disconnected foreground may no longer wait, but its accepted
	// operation's result must still be available to the next foreground.
	saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.queries.CompleteVoiceLiveToolCall(saveCtx, store.CompleteVoiceLiveToolCallParams{VoiceSessionID: session.ID, CallID: request.CallId, Output: output, State: state}); err != nil {
		return "", fmt.Errorf("save live tool result: %w", err)
	}
	return output, nil
}

// answeredForUser says whether a confirmed call came in the very turn that
// asked: the model said yes for the user. Asking again then makes them
// confirm twice, so the model is told to wait for the answer instead.
func (s *Service) answeredForUser(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (bool, error) {
	var args struct {
		Confirmed voicelive.LooseBool `json:"confirmed"`
	}
	// Arguments that do not decode were never a yes.
	decoded := voicelive.DecodeArguments(request.Arguments, &args) == nil
	if !decoded || !bool(args.Confirmed) || request.TurnId == "" {
		return false, nil
	}
	// This call has just asked once more; an earlier question of this turn
	// is still open.
	asked, err := s.queries.CountVoiceLiveTurnConfirmations(ctx, store.CountVoiceLiveTurnConfirmationsParams{
		VoiceSessionID: session.ID, TurnID: request.TurnId, Tool: request.Name,
	})
	return asked > 1, err
}

// refuseTaskRoomVisit keeps the live voice out of a Task's working Room by
// id unless the user asked for that Room itself: the Task's results, files
// included, are in the Room it came from.
func (s *Service) refuseTaskRoomVisit(ctx context.Context, arguments string) (string, error) {
	var args struct {
		Action    string `json:"action"`
		Target    string `json:"target"`
		Confirmed any    `json:"confirmed"`
	}
	// Arguments that do not decode are refused by the page tool itself.
	decoded := voicelive.DecodeArguments(arguments, &args) == nil
	if !decoded || args.Action != "open_room" || args.Confirmed == true || args.Confirmed == "true" {
		return "", nil
	}
	match := taskRoomTarget.FindStringSubmatch(strings.TrimSpace(args.Target))
	if match == nil {
		return "", nil
	}
	taskRoom, err := s.queries.IsVoiceLiveTaskWorkRoom(ctx, match[1])
	if err != nil || !taskRoom {
		return "", err
	}
	return voicelive.Output(map[string]string{
		"status": "task_room",
		"detail": "That is a background task's working room; its results and files are in the user's own room. Open a file with open_document instead. Open this room only if the user asked for the task's own room, by calling again with confirmed=true.",
	}), nil
}

// taskRoomTarget is a Room id or Room page path, as page_action takes it.
var taskRoomTarget = regexp.MustCompile(`^(?:/t/[^/]+/rooms/)?(room_[A-Za-z0-9_-]{1,128})(?:/chat)?$`)
