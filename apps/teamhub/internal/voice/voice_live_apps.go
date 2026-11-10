package voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

var voiceLiveMailApps = []string{"gmail", "outlook"}

// voiceLiveAppSession is the Agent credential and one connected account.
type voiceLiveAppSession struct {
	principal  agentcredential.Principal
	token      string
	connection agentconnectedapps.ConnectedApp
}

// voiceLiveApp picks the account a call uses; output is what the live model
// is told instead when none, or more than one, fits.
func (s *Service) voiceLiveApp(ctx context.Context, session voicelive.Session, appKeys []string, account string) (voiceLiveAppSession, string, error) {
	principal, token, err := s.voiceLiveAgent(ctx, session)
	if errors.Is(err, errVoiceLiveAgentUnavailable) {
		return voiceLiveAppSession{}, voicelive.ErrorOutput("agent_unavailable"), nil
	}
	if err != nil {
		return voiceLiveAppSession{}, "", err
	}
	apps, err := s.agentConnectedApps.List(ctx, token)
	if err != nil {
		return voiceLiveAppSession{}, "", err
	}
	matches := []agentconnectedapps.ConnectedApp{}
	for _, app := range apps {
		for _, key := range appKeys {
			if app.AppKey == key && (account == "" || strings.EqualFold(app.Identity, strings.TrimSpace(account))) {
				matches = append(matches, app)
			}
		}
	}
	switch len(matches) {
	case 0:
		return voiceLiveAppSession{}, voicelive.Output(map[string]any{"error": "app_not_connected", "apps": appKeys}), nil
	case 1:
		return voiceLiveAppSession{principal: principal, token: token, connection: matches[0]}, "", nil
	}
	accounts := make([]string, 0, len(matches))
	for _, app := range matches {
		accounts = append(accounts, app.Identity)
	}
	return voiceLiveAppSession{}, voicelive.Output(map[string]any{"error": "choose_account", "accounts": accounts}), nil
}

// call runs one read the connector commands make; output is the error the
// live model is told instead.
func (s *Service) voiceLiveAppCall(ctx context.Context, app voiceLiveAppSession, request teamhubinternal.VoiceLiveToolCall, slug string, arguments map[string]any) (map[string]any, string, error) {
	result, err := s.agentConnectedApps.Execute(
		agentconnectedapps.WithOperationID(ctx, voiceLiveInvocationID(voicelive.Session{ID: request.VoiceSessionId}, request)),
		app.token, agentconnectedapps.ExecuteInput{
			ConnectionID: app.connection.ConnectionID, ToolSlug: slug,
			ToolVersion: voicelive.ConnectorVersions[app.connection.AppKey], Arguments: arguments,
		})
	var domain *agentconnectedapps.Error
	if errors.As(err, &domain) {
		return nil, voicelive.Output(map[string]string{"error": domain.Code, "detail": voicelive.Snippet(domain.Message)}), nil
	}
	if err != nil {
		return nil, "", err
	}
	if result.Confirmation != nil {
		return nil, voicelive.ErrorOutput("not_a_read"), nil
	}
	data, _ := result.Data.(map[string]any)
	return data, "", nil
}

func (s *Service) runVoiceLiveAppTool(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.AppArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	switch request.Name {
	case voicelive.ToolSaveEmailDraft:
		return s.saveVoiceLiveEmailDraft(ctx, session, request, args)
	case voicelive.ToolSendEmailCanvas:
		return s.sendVoiceLiveEmailCanvas(ctx, session, request, args)
	case voicelive.ToolSendSlack:
		return s.sendVoiceLiveSlack(ctx, session, request, args)
	case voicelive.ToolSlackInbox:
		return s.voiceLiveSlackInbox(ctx, session, request, args)
	}
	keys := voiceLiveMailApps
	switch request.Name {
	case voicelive.ToolSearchSlack, voicelive.ToolReadSlack:
		keys = []string{"slack"}
	case voicelive.ToolListCalendar, voicelive.ToolFindFreeTime:
		keys = []string{"google_calendar"}
	}
	app, output, err := s.voiceLiveApp(ctx, session, keys, args.Account)
	if output != "" || err != nil {
		return output, err
	}
	call := func(slug string, arguments map[string]any) (map[string]any, string, error) {
		return s.voiceLiveAppCall(ctx, app, request, slug, arguments)
	}
	account := app.connection.Identity
	switch request.Name {
	case voicelive.ToolSearchMail:
		var raw map[string]any
		if app.connection.AppKey == "gmail" {
			raw, output, err = call("GMAIL_FETCH_EMAILS", map[string]any{
				"query":           voicelive.GmailQuery(args.Query, args.Folder, bool(args.UnreadOnly)),
				"max_results":     voicelive.AppResultLimit,
				"include_payload": false, "include_spam_trash": false,
			})
		} else {
			folder := map[string]string{"all": "allfolders", "sent": "sentitems"}[args.Folder]
			if folder == "" {
				folder = "inbox"
			}
			arguments := map[string]any{"top": voicelive.AppResultLimit, "folder": folder}
			if bool(args.UnreadOnly) {
				arguments["filter"] = "receivedDateTime ge 0001-01-01T00:00:00Z and isRead eq false"
			}
			slug := "OUTLOOK_QUERY_EMAILS"
			if strings.TrimSpace(args.Query) != "" {
				slug, arguments["search"] = "OUTLOOK_LIST_MESSAGES", strings.TrimSpace(args.Query)
			} else {
				arguments["orderby"] = []string{"receivedDateTime desc"}
			}
			raw, output, err = call(slug, arguments)
		}
		if output != "" || err != nil {
			return output, err
		}
		list, ok := voicelive.ListRows(raw, "messages", "value")
		if !ok {
			return voicelive.ErrorOutput("incomplete_response"), nil
		}
		messages := make([]map[string]any, 0, len(list))
		for _, message := range list {
			messages = append(messages, voicelive.MailSummary(app.connection.AppKey, message))
		}
		return voicelive.Output(map[string]any{"account": account, "messages": messages}), nil
	case voicelive.ToolReadMail:
		if strings.TrimSpace(args.MessageID) == "" {
			return "", voicelive.ErrInvalid
		}
		slug, arguments := "OUTLOOK_GET_MESSAGE", map[string]any{"message_id": strings.TrimSpace(args.MessageID)}
		if app.connection.AppKey == "gmail" {
			slug, arguments["format"] = "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "full"
		}
		raw, output, err := call(slug, arguments)
		if output != "" || err != nil {
			return output, err
		}
		return voicelive.Output(voicelive.MailMessage(app.connection.AppKey, raw)), nil
	case voicelive.ToolSearchSlack:
		if !voicelive.ValidQuery(args.Query) {
			return "", voicelive.ErrInvalid
		}
		raw, output, err := call("SLACK_SEARCH_MESSAGES", map[string]any{
			"query": strings.TrimSpace(args.Query), "count": voicelive.AppResultLimit, "cursor": "*",
			"sort": "timestamp", "sort_dir": "desc", "highlight": false, "auto_paginate": false,
		})
		if output != "" || err != nil {
			return output, err
		}
		list, ok := voicelive.ListRows(voiceLiveRecord(raw["messages"]), "matches")
		if !ok {
			return voicelive.ErrorOutput("incomplete_response"), nil
		}
		messages := make([]map[string]any, 0, len(list))
		for _, message := range list {
			messages = append(messages, voicelive.SlackMessage(message, ""))
		}
		return voicelive.Output(map[string]any{"messages": messages}), nil
	case voicelive.ToolReadSlack:
		channel := strings.TrimSpace(args.Channel)
		if channel == "" {
			return "", voicelive.ErrInvalid
		}
		channel, output, err = voiceLiveSlackChannel(call, channel)
		if output != "" || err != nil {
			return output, err
		}
		slug, arguments := "SLACK_FETCH_CONVERSATION_HISTORY", map[string]any{"channel": channel, "limit": voicelive.AppResultLimit}
		if thread := strings.TrimSpace(args.ThreadTS); thread != "" {
			slug, arguments["ts"] = "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION", thread
		}
		raw, output, err := call(slug, arguments)
		if output != "" || err != nil {
			return output, err
		}
		list, ok := voicelive.ListRows(raw, "messages")
		if !ok {
			return voicelive.ErrorOutput("incomplete_response"), nil
		}
		messages := make([]map[string]any, 0, len(list))
		for _, message := range list {
			messages = append(messages, voicelive.SlackMessage(message, channel))
		}
		return voicelive.Output(map[string]any{"channel_id": channel, "messages": messages}), nil
	case voicelive.ToolListCalendar, voicelive.ToolFindFreeTime:
		from, to, ok := voicelive.AppTimeRange(args.From, args.To, time.Now())
		if !ok {
			return voicelive.ErrorOutput("invalid_time_range"), nil
		}
		if request.Name == voicelive.ToolFindFreeTime {
			raw, output, err := call("GOOGLECALENDAR_FREE_BUSY_QUERY", map[string]any{
				"timeMin": from.Format(time.RFC3339), "timeMax": to.Format(time.RFC3339),
				"items": []map[string]string{{"id": "primary"}}, "calendarExpansionMax": 1,
			})
			if output != "" || err != nil {
				return output, err
			}
			minutes := args.Minutes
			if minutes <= 0 {
				minutes = 30
			}
			return voicelive.Output(map[string]any{"free": voicelive.FreeSlots(raw, "primary", from, to, minutes)}), nil
		}
		arguments := map[string]any{
			"calendarId": "primary", "maxResults": voicelive.AppResultLimit, "timeMin": from.Format(time.RFC3339),
			"timeMax": to.Format(time.RFC3339), "singleEvents": true, "orderBy": "startTime", "showDeleted": false,
		}
		if query := strings.TrimSpace(args.Query); query != "" {
			arguments["query"] = query
		}
		raw, output, err := call("GOOGLECALENDAR_EVENTS_LIST", arguments)
		if output != "" || err != nil {
			return output, err
		}
		list, ok := voicelive.ListRows(raw, "items", "events")
		if !ok {
			return voicelive.ErrorOutput("incomplete_response"), nil
		}
		events := make([]map[string]any, 0, len(list))
		for _, event := range list {
			events = append(events, voicelive.CalendarEvent(event))
		}
		return voicelive.Output(map[string]any{"events": events}), nil
	}
	return voicelive.ErrorOutput("unknown_tool"), nil
}

func voiceLiveRecord(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// voiceLiveMailCanvas reads the canvas a draft or a send uses and builds its
// message here, without calling Gmail.
func (s *Service) voiceLiveMailCanvas(ctx context.Context, session voicelive.Session, args voicelive.AppArguments) (voiceLiveAppSession, voiceLiveCanvasState, agentconnectedapps.CanvasDraft, string, error) {
	if strings.TrimSpace(args.DocumentID) == "" {
		return voiceLiveAppSession{}, voiceLiveCanvasState{}, agentconnectedapps.CanvasDraft{}, "", voicelive.ErrInvalid
	}
	app, output, err := s.voiceLiveApp(ctx, session, []string{"gmail"}, args.Account)
	if output != "" || err != nil {
		return app, voiceLiveCanvasState{}, agentconnectedapps.CanvasDraft{}, output, err
	}
	canvas, err := s.voiceLiveCanvas(ctx, app.principal, args.DocumentID)
	if output, handled := voiceLiveCanvasError(err); handled {
		return app, canvas, agentconnectedapps.CanvasDraft{}, output, nil
	}
	if err != nil {
		return app, canvas, agentconnectedapps.CanvasDraft{}, "", err
	}
	if canvas.fields["status"] == "sent" {
		// Named, so the model can tell this canvas from the one it meant.
		return app, canvas, agentconnectedapps.CanvasDraft{}, voicelive.Output(map[string]string{
			"error": "already_sent", "document_id": canvas.documentID, "subject": canvas.fields["subject"], "to": canvas.fields["to"],
			"detail": "This canvas was sent before. If the user means another email, find its own canvas; never say this one was just sent.",
		}), nil
	}
	built, err := s.canvas.GmailCanvasDraftRaw(ctx, app.principal.TenantID, app.principal.AgentID, args.DocumentID, nil, nil, nil)
	var invalid *agentconnectedapps.CanvasDraftError
	if errors.As(err, &invalid) {
		return app, canvas, built, voicelive.Output(map[string]string{"error": "canvas_not_mailable", "detail": invalid.Message}), nil
	}
	return app, canvas, built, "", err
}

// voiceLiveDraftKey names a canvas's draft in one Gmail account.
func voiceLiveDraftKey(canvas voiceLiveCanvasState, app voiceLiveAppSession) string {
	return canvas.documentID + "\x00" + app.connection.ConnectionID
}

// knownVoiceLiveDraft is the draft saved here for the canvas, unless the
// canvas names another one since.
func (s *Service) knownVoiceLiveDraft(key string, canvas voiceLiveCanvasState) (savedCanvasDraft, bool) {
	loaded, ok := s.savedCanvasDrafts.Load(key)
	if !ok {
		return savedCanvasDraft{}, false
	}
	saved := loaded.(savedCanvasDraft)
	named := canvas.fields["external_id"]
	return saved, named == "" || named == saved.draftID
}

// voiceLiveCanvasDraft is the canvas's Gmail draft for its current content:
// one saved ahead (waiting for a save under way), or a new save.
func (s *Service) voiceLiveCanvasDraft(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, app voiceLiveAppSession, canvas voiceLiveCanvasState, built agentconnectedapps.CanvasDraft) (savedCanvasDraft, string, error) {
	key, digest := voiceLiveDraftKey(canvas, app), canvas.draftDigest()
	// A save under way finishes first, whatever it saves: two saves at once
	// could each make a new draft.
	if loaded, ok := s.canvasDraftJobs.Load(key); ok {
		job := loaded.(*canvasDraftJob)
		select {
		case <-job.done:
		case <-ctx.Done():
			return savedCanvasDraft{}, "", ctx.Err()
		}
		if job.digest == digest && job.err == nil && job.output == "" {
			return job.saved, "", nil
		}
	}
	// Building and saving take provider and storage round trips; a canvas
	// unchanged since its draft was saved here is already exactly that draft.
	if saved, ok := s.knownVoiceLiveDraft(key, canvas); ok && saved.digest == digest {
		return saved, "", nil
	}
	return s.storeVoiceLiveCanvasDraft(ctx, session, request, app, canvas, built, "", true)
}

// startVoiceLiveCanvasDraft saves the draft in the background, after any
// save of it under way, so a yes need not wait for the whole upload. record
// also writes the draft into the canvas header, which changes the canvas.
func (s *Service) startVoiceLiveCanvasDraft(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, app voiceLiveAppSession, canvas voiceLiveCanvasState, built agentconnectedapps.CanvasDraft, record bool) {
	key, digest := voiceLiveDraftKey(canvas, app), canvas.draftDigest()
	var previous *canvasDraftJob
	if loaded, ok := s.canvasDraftJobs.Load(key); ok {
		if previous = loaded.(*canvasDraftJob); previous.digest == digest {
			return
		}
	}
	if saved, ok := s.knownVoiceLiveDraft(key, canvas); ok && saved.digest == digest {
		return
	}
	job := &canvasDraftJob{digest: digest, done: make(chan struct{})}
	s.canvasDraftJobs.Store(key, job)
	go func() {
		defer close(job.done)
		if previous != nil {
			<-previous.done
		}
		run, cancel := context.WithTimeout(context.WithoutCancel(ctx), voiceLiveConfirmedWriteTimeout)
		defer cancel()
		job.saved, job.output, job.err = s.storeVoiceLiveCanvasDraft(run, session, request, app, canvas, built, "_draft", record)
		if (job.err != nil || job.output != "") && s.logger != nil {
			s.logger.Warn("live canvas draft not saved ahead", "voice_session_id", session.ID, "output", job.output, "error", job.err)
		}
	}()
}

// storeVoiceLiveCanvasDraft saves built as the Agent's Gmail draft, or
// updates the draft the canvas or an earlier save here names. record also
// writes the draft into the canvas header.
func (s *Service) storeVoiceLiveCanvasDraft(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, app voiceLiveAppSession, canvas voiceLiveCanvasState, built agentconnectedapps.CanvasDraft, step string, record bool) (savedCanvasDraft, string, error) {
	key := voiceLiveDraftKey(canvas, app)
	draftID := canvas.fields["external_id"]
	if known, ok := s.knownVoiceLiveDraft(key, canvas); ok && draftID == "" {
		draftID = known.draftID
	}
	draft, err := s.agentConnectedApps.SaveGmailDraft(
		agentconnectedapps.WithOperationID(ctx, voiceLiveInvocationID(session, request)+step),
		app.token, app.connection.ConnectionID, draftID, built.Raw)
	var domain *agentconnectedapps.Error
	if errors.As(err, &domain) {
		return savedCanvasDraft{}, voicelive.Output(map[string]string{"error": domain.Code, "detail": voicelive.Snippet(domain.Message)}), nil
	}
	if err != nil {
		return savedCanvasDraft{}, "", err
	}
	if record {
		fields := map[string]string{}
		for name, value := range canvas.fields {
			fields[name] = value
		}
		fields["status"], fields["external_id"], fields["link"] = "draft", draft.DraftID, "https://mail.google.com/mail/#drafts"
		s.recordVoiceLiveCanvasHeader(ctx, session, request, app.principal, canvas, fields, "draft")
	}
	saved := savedCanvasDraft{draftID: draft.DraftID, digest: canvas.draftDigest(), attachments: built.Attachments}
	s.savedCanvasDrafts.Store(key, saved)
	return saved, "", nil
}

// voiceLiveDraftSyncDelay is how long a canvas stays unchanged before its
// draft is saved ahead.
const voiceLiveDraftSyncDelay = 3 * time.Second

// scheduleVoiceLiveDraftSync saves a canvas's draft once the canvas has
// stayed unchanged for a moment, so sending it later waits only for the
// send. Each change starts the wait again.
func (s *Service) scheduleVoiceLiveDraftSync(session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, documentID string) {
	// The entry exists before its timer can fire, so the timer only ever
	// reads a value set before it started.
	entry := &canvasDraftSync{}
	entry.timer = time.AfterFunc(voiceLiveDraftSyncDelay, func() {
		s.canvasDraftSyncs.CompareAndDelete(documentID, entry)
		s.syncVoiceLiveCanvasDraft(session, request, documentID)
	})
	if previous, loaded := s.canvasDraftSyncs.Swap(documentID, entry); loaded {
		previous.(*canvasDraftSync).timer.Stop()
	}
}

// syncVoiceLiveCanvasDraft saves the draft of a Gmail canvas that carries
// files, whose upload is what a send would wait for; a draft of text alone
// saves in a moment when asked. Nothing is written into the canvas, which
// the live model may be changing.
func (s *Service) syncVoiceLiveCanvasDraft(session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, documentID string) {
	ctx, cancel := context.WithTimeout(context.Background(), voiceLiveConfirmedWriteTimeout)
	defer cancel()
	app, canvas, built, output, err := s.voiceLiveMailCanvas(ctx, session, voicelive.AppArguments{DocumentID: documentID})
	if err != nil && s.logger != nil {
		s.logger.Warn("live canvas draft not synced", "voice_session_id", session.ID, "document_id", documentID, "error", err)
	}
	if output != "" || err != nil || len(built.Attachments) == 0 {
		return
	}
	// Each content is its own save, idempotent on its own operation.
	sync := request
	sync.CallId = request.CallId + ":draft:" + canvas.draftDigest()
	s.startVoiceLiveCanvasDraft(ctx, session, sync, app, canvas, built, false)
}

// recordVoiceLiveCanvasHeader writes the header lines back, as the canvas
// Skill does after delivering. The email already went where it went, so a
// canvas the user changed meanwhile only keeps its old lines.
func (s *Service) recordVoiceLiveCanvasHeader(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, principal agentcredential.Principal, canvas voiceLiveCanvasState, fields map[string]string, step string) {
	if voicelive.EmailCanvasHeader(fields) == voicelive.EmailCanvasHeader(canvas.fields) {
		return
	}
	change, err := json.Marshal([]map[string]string{{
		"kind": "edit_document", "parser_version": "markdown-v1", "command": "block_replace",
		"block_id": canvas.firstBlockID, "content": voicelive.EmailCanvasHeader(fields),
	}})
	if err != nil {
		return
	}
	_, err = s.documents.ApplySemanticMutation(ctx, document.ApplySemanticMutationInput{
		Principal: &principal, TargetKind: "room", TargetID: session.RoomID, DocumentID: canvas.documentID,
		SourceInvocationID: voiceLiveInvocationID(session, request) + "_" + step,
		SchemaVersion:      "blocknote-semantic-v1", ExpectedRevisionID: canvas.revisionID, SemanticChange: change,
	})
	if err != nil && s.logger != nil {
		s.logger.Warn("live canvas header not recorded", "voice_session_id", session.ID, "step", step, "error_type", fmt.Sprintf("%T", err))
	}
}

func (s *Service) saveVoiceLiveEmailDraft(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, args voicelive.AppArguments) (string, error) {
	app, canvas, built, output, err := s.voiceLiveMailCanvas(ctx, session, args)
	if output != "" || err != nil {
		return output, err
	}
	saved, output, err := s.voiceLiveCanvasDraft(ctx, session, request, app, canvas, built)
	if output != "" || err != nil {
		return output, err
	}
	return voicelive.Output(map[string]any{"status": "saved", "draft_id": saved.draftID, "account": app.connection.Identity, "attachments": saved.attachments}), nil
}

// sendVoiceLiveEmailCanvas sends the canvas once the user said yes, in a
// later turn, to exactly what they heard: the yes is bound to the canvas's
// recipients, subject, body and files. The question comes at once, built
// here; the Gmail draft saves while the user answers.
func (s *Service) sendVoiceLiveEmailCanvas(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, args voicelive.AppArguments) (string, error) {
	app, canvas, built, output, err := s.voiceLiveMailCanvas(ctx, session, args)
	if output != "" || err != nil {
		return output, err
	}
	if strings.TrimSpace(canvas.fields["to"]) == "" {
		return voicelive.ErrorOutput("no_recipients"), nil
	}
	summary := fmt.Sprintf("Send the email %q from %s to %s", canvas.fields["subject"], app.connection.Identity, canvas.fields["to"])
	if cc := strings.TrimSpace(canvas.fields["cc"]); cc != "" {
		summary += ", cc " + cc
	}
	// Naming the attachments, or their absence, keeps the live voice from
	// promising a file the canvas does not hold.
	if len(built.Attachments) > 0 {
		summary += ", attaching " + strings.Join(built.Attachments, ", ")
	} else {
		summary += ", with no attachments"
	}
	summary += ". It cannot be undone."
	yes, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), summary+"\x00"+canvas.draftDigest())
	if err != nil {
		return "", err
	}
	if !yes {
		s.startVoiceLiveCanvasDraft(ctx, session, request, app, canvas, built, true)
		return voicelive.NeedsConfirmation(summary), nil
	}
	saved, output, err := s.voiceLiveCanvasDraft(ctx, session, request, app, canvas, built)
	if output != "" || err != nil {
		return output, err
	}
	// The yes above is bound to this content, which the draft holds.
	status, outcome, output, err := s.voiceLiveWrite(ctx, session, request, app, "GMAIL_SEND_DRAFT", map[string]any{"draft_id": saved.draftID}, summary,
		func(string) (bool, error) { return true, nil })
	if output != "" || err != nil {
		return output, err
	}
	switch status {
	case "succeeded":
		fields := map[string]string{}
		for name, value := range canvas.fields {
			fields[name] = value
		}
		fields["status"], fields["external_id"] = "sent", saved.draftID
		if latest, err := s.voiceLiveCanvas(ctx, app.principal, args.DocumentID); err == nil {
			s.recordVoiceLiveCanvasHeader(ctx, session, request, app.principal, latest, fields, "sent")
		}
		return voicelive.Output(map[string]string{"status": "sent", "to": canvas.fields["to"], "subject": canvas.fields["subject"]}), nil
	case "failed":
		return voicelive.Output(map[string]string{"error": "send_failed", "detail": voicelive.Snippet(outcome)}), nil
	}
	return voicelive.Output(map[string]string{"status": "outcome_unknown", "detail": voicelive.Snippet(outcome)}), nil
}

// voiceLiveConfirmedWriteTimeout bounds a write the user said yes to; the
// live voice waits as long for it (live-worker.ts confirmedWriteTimeoutMs).
const voiceLiveConfirmedWriteTimeout = time.Minute

// voiceLiveConfirmedWrite runs one connector write the user said yes to, in
// a later turn, after hearing summary: TeamHub holds the write for
// confirmation, and the yes is bound to exactly the held call. output is what
// the live model is told instead: the question to ask, or a provider refusal.
func (s *Service) voiceLiveConfirmedWrite(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, app voiceLiveAppSession, slug string, arguments map[string]any, summary string, confirmed bool) (status, outcome, output string, err error) {
	return s.voiceLiveWrite(ctx, session, request, app, slug, arguments, summary, func(digest string) (bool, error) {
		return s.voiceLiveConfirmed(ctx, session, request, confirmed, summary+"\x00"+digest)
	})
}

// voiceLiveWrite holds one connector write for confirmation and runs it once
// confirm accepts the held call's digest.
func (s *Service) voiceLiveWrite(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, app voiceLiveAppSession, slug string, arguments map[string]any, summary string, confirm func(digest string) (bool, error)) (status, outcome, output string, err error) {
	prepared, err := s.agentConnectedApps.Execute(
		agentconnectedapps.WithOperationID(ctx, voiceLiveInvocationID(session, request)),
		app.token, agentconnectedapps.ExecuteInput{
			ConnectionID: app.connection.ConnectionID, ToolSlug: slug,
			ToolVersion: voicelive.ConnectorVersions[app.connection.AppKey], Arguments: arguments,
		})
	var domain *agentconnectedapps.Error
	if errors.As(err, &domain) {
		return "", "", voicelive.Output(map[string]string{"error": domain.Code, "detail": voicelive.Snippet(domain.Message)}), nil
	}
	if err != nil {
		return "", "", "", err
	}
	if prepared.Confirmation == nil {
		return "", "", "", fmt.Errorf("%s was not held for confirmation", slug)
	}
	ok, err := confirm(prepared.Confirmation.Digest)
	if err != nil {
		return "", "", "", err
	}
	if !ok {
		return "", "", voicelive.NeedsConfirmation(summary), nil
	}
	// The user said yes: the write runs to its end even when the live voice
	// stops waiting for it, so a slow provider never cuts it off half way.
	run, cancel := context.WithTimeout(context.WithoutCancel(ctx), voiceLiveConfirmedWriteTimeout)
	defer cancel()
	status, outcome, _ = s.agentConnectedApps.ExecuteConfirmed(run, voiceLiveInvocationID(session, request),
		session.TenantID, session.Agent.ID, prepared.Confirmation.Connection.ID, prepared.Confirmation.Action)
	return status, outcome, "", nil
}
