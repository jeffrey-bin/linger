package voice

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"path"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// The live voice sends Slack messages and finds what came to the user on
// Slack, as the call's Agent, through the connector calls the Agent's Slack
// commands make. A colleague is found by their email in this app.

type voiceLiveSlackCall func(slug string, arguments map[string]any) (map[string]any, string, error)

// sendVoiceLiveSlack sends one Slack message, or one file with a note, once
// the user said yes to where it goes and what it says.
func (s *Service) sendVoiceLiveSlack(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, args voicelive.AppArguments) (string, error) {
	text := strings.TrimSpace(args.Text)
	channel, person, userID, thread := strings.TrimSpace(args.Channel), strings.TrimSpace(args.Person), strings.TrimSpace(args.UserID), strings.TrimSpace(args.ThreadTS)
	documentID, taskID, file := strings.TrimSpace(args.DocumentID), strings.TrimSpace(args.TaskID), strings.TrimSpace(args.File)
	attaching := documentID != "" || taskID != ""
	targets := 0
	for _, target := range []bool{channel != "", person != "", userID != "", bool(args.ToSelf)} {
		if target {
			targets++
		}
	}
	if text == "" && !attaching || utf8.RuneCountInString(text) > voicelive.MaxSlackTextRunes || targets != 1 || thread != "" && channel == "" ||
		documentID != "" && taskID != "" || file != "" && taskID == "" {
		return "", voicelive.ErrInvalid
	}
	app, output, err := s.voiceLiveApp(ctx, session, []string{"slack"}, args.Account)
	if output != "" || err != nil {
		return output, err
	}
	call := func(slug string, arguments map[string]any) (map[string]any, string, error) {
		return s.voiceLiveAppCall(ctx, app, request, slug, arguments)
	}
	where := channel
	switch {
	case channel != "":
		channel, output, err = voiceLiveSlackChannel(call, channel)
	default:
		where = "Slack user " + userID
		switch {
		case person != "":
			userID, where, output, err = s.voiceLiveSlackPerson(ctx, session, call, person)
		case bool(args.ToSelf):
			where = "themself"
		}
		if output == "" && err == nil {
			if args.ToSelf {
				channel, output, err = s.voiceLiveSlackSelfDM(ctx, app, call)
			} else {
				channel, output, err = voiceLiveSlackDM(call, userID)
			}
		}
		where += " (direct message)"
	}
	if output != "" || err != nil {
		return output, err
	}
	if thread != "" {
		where += ", in a thread"
	}
	var status, outcome string
	if attaching {
		attachment, output, err := s.voiceLiveFileAttachment(ctx, session, app.principal, documentID, taskID, file)
		if output != "" || err != nil {
			return output, err
		}
		summary := fmt.Sprintf("Send on Slack as %s to %s the file %s (%s)", app.connection.Identity, where, attachment.name, voiceLiveFileSize(len(attachment.content)))
		if text != "" {
			summary += " with: " + text
		}
		summary += ". It cannot be undone."
		// Each staging names a new provider object, so the yes is bound to the
		// file's bytes and the message, and the file is staged only after it.
		digest := sha256.Sum256(attachment.content)
		ok, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed),
			strings.Join([]string{summary, channel, thread, text, hex.EncodeToString(digest[:])}, "\x00"))
		if err != nil {
			return "", err
		}
		if !ok {
			return voicelive.NeedsConfirmation(summary), nil
		}
		const upload = "SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK"
		staged, err := s.agentConnectedApps.StageFile(ctx, app.token, agentconnectedapps.FileUploadInput{
			ConnectionID: app.connection.ConnectionID, ToolSlug: upload, ToolVersion: voicelive.ConnectorVersions["slack"],
			Filename: attachment.name, Mimetype: attachment.mediaType,
		}, attachment.content)
		var domain *agentconnectedapps.Error
		if errors.As(err, &domain) {
			return voicelive.Output(map[string]string{"error": domain.Code, "detail": voicelive.Snippet(domain.Message)}), nil
		}
		if err != nil {
			return "", err
		}
		arguments := map[string]any{"file": []any{staged}, "channels": channel}
		if text != "" {
			arguments["initial_comment"] = text
		}
		if thread != "" {
			arguments["thread_ts"] = thread
		}
		status, outcome, output, err = s.voiceLiveWrite(ctx, session, request, app, upload, arguments, summary,
			func(string) (bool, error) { return true, nil })
		if output != "" || err != nil {
			return output, err
		}
	} else {
		arguments := map[string]any{"channel": channel, "markdown_text": text, "reply_broadcast": false}
		if thread != "" {
			arguments["thread_ts"] = thread
		}
		summary := fmt.Sprintf("Send on Slack as %s to %s: %s. It cannot be undone.", app.connection.Identity, where, text)
		status, outcome, output, err = s.voiceLiveConfirmedWrite(ctx, session, request, app, "SLACK_SEND_MESSAGE", arguments, summary, bool(args.Confirmed))
		if output != "" || err != nil {
			return output, err
		}
	}
	switch status {
	case "succeeded":
		return voicelive.Output(map[string]string{"status": "sent", "to": where}), nil
	case "failed":
		return voicelive.Output(map[string]string{"error": "send_failed", "detail": voicelive.Snippet(outcome)}), nil
	}
	return voicelive.Output(map[string]string{"status": "outcome_unknown", "detail": voicelive.Snippet(outcome)}), nil
}

// voiceLiveAttachment is one file the live voice sends: its name, type and
// bytes.
type voiceLiveAttachment struct {
	name, mediaType string
	content         []byte
}

// voiceLiveFileAttachment reads the file a Slack send or an email canvas
// attaches: a Document
// the call's Agent reads, as its Agent download gives it, or a task's output
// file on the user's Local Computer. output is what the live model is told
// instead when it cannot be read.
func (s *Service) voiceLiveFileAttachment(ctx context.Context, session voicelive.Session, principal agentcredential.Principal, documentID, taskID, file string) (voiceLiveAttachment, string, error) {
	if taskID != "" && file == "" {
		// A task's output is a folder: the model must name one file in it.
		return voiceLiveAttachment{}, voicelive.Output(map[string]string{
			"error": "file_required", "next": "List this task's output files with task_files, then call again with the path of the one to attach.",
		}), nil
	}
	if taskID != "" {
		task, tools, call, err := s.voiceTaskComputer(ctx, session, taskID)
		if err != nil {
			output, err := voiceFileError(err)
			return voiceLiveAttachment{}, output, err
		}
		filename := voicelive.TaskFilePath(file, task.WorkItemID)
		if filename == "" || path.IsAbs(filename) || path.Clean(filename) != filename || filename == ".." || strings.HasPrefix(filename, "../") {
			return voiceLiveAttachment{}, voicelive.ErrorOutput("invalid_file_path"), nil
		}
		var content bytes.Buffer
		if err := copyVoiceTaskFile(ctx, tools, call, filename, &content); err != nil {
			output, err := voiceFileError(err)
			return voiceLiveAttachment{}, output, err
		}
		name := path.Base(filename)
		return voiceLiveAttachment{name: name, mediaType: voiceLiveMediaType(name, ""), content: content.Bytes()}, "", nil
	}
	download, err := s.documents.DownloadAgentFileConditional(ctx, principal.TenantID, principal.AgentID, documentID, "markdown", "")
	if errors.Is(err, document.ErrNotFound) || errors.Is(err, document.ErrInvalidInput) {
		return voiceLiveAttachment{}, voicelive.ErrorOutput("document_not_found"), nil
	}
	if err != nil {
		return voiceLiveAttachment{}, "", err
	}
	content := download.InlineBytes
	if content == nil {
		if download.SizeBytes > maxVoiceTaskFileBytes {
			return voiceLiveAttachment{}, voicelive.ErrorOutput("file_too_large"), nil
		}
		object, err := s.artifacts.Open(ctx, download.ObjectKey)
		if err != nil {
			return voiceLiveAttachment{}, "", err
		}
		defer object.Close()
		if content, err = io.ReadAll(io.LimitReader(object, maxVoiceTaskFileBytes+1)); err != nil {
			return voiceLiveAttachment{}, "", err
		}
	}
	if len(content) > maxVoiceTaskFileBytes {
		return voiceLiveAttachment{}, voicelive.ErrorOutput("file_too_large"), nil
	}
	// The download names the stored file, which may be a rendering's own
	// name; the user knows the Document by its title.
	title, err := s.queries.GetVoiceLiveDocumentTitle(ctx, store.GetVoiceLiveDocumentTitleParams{DocumentID: documentID, TenantID: principal.TenantID})
	if err != nil {
		return voiceLiveAttachment{}, "", err
	}
	return voiceLiveAttachment{name: voiceLiveFileName(title, download.Filename), mediaType: voiceLiveMediaType(download.Filename, download.MediaType), content: content}, "", nil
}

// voiceLiveFileName names a Document's file after its title, which is what
// the user knows it by: a stored filename may be a rendering's own name.
// The download's extension follows the title unless the title ends in it.
func voiceLiveFileName(title, filename string) string {
	name := strings.NewReplacer("/", "-", "\\", "-").Replace(strings.Join(strings.Fields(title), " "))
	if name == "" {
		name = path.Base(strings.TrimSpace(filename))
	}
	if ext := path.Ext(filename); ext != "" && !strings.EqualFold(path.Ext(name), ext) {
		name += ext
	}
	return name
}

// voiceLiveMediaType is a file's bare media type: the stored one, else one
// its extension names.
func voiceLiveMediaType(name, stored string) string {
	for _, candidate := range []string{stored, mime.TypeByExtension(strings.ToLower(path.Ext(name)))} {
		if media, _, err := mime.ParseMediaType(candidate); err == nil {
			return media
		}
	}
	if strings.EqualFold(path.Ext(name), ".md") {
		return "text/markdown"
	}
	return "application/octet-stream"
}

// voiceLiveFileSize says a file's size the way a person would.
func voiceLiveFileSize(size int) string {
	switch {
	case size >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(size)/(1<<20))
	case size >= 1<<10:
		return fmt.Sprintf("%d KB", size>>10)
	}
	return fmt.Sprintf("%d bytes", size)
}

// voiceLiveSlackInbox finds the direct messages to the user and the messages
// that mention them since a local date: two Slack searches, merged.
func (s *Service) voiceLiveSlackInbox(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, args voicelive.AppArguments) (string, error) {
	after, ok := voicelive.SlackSearchSince(args.Since, time.Now())
	if !ok {
		return voicelive.ErrorOutput("invalid_date"), nil
	}
	app, output, err := s.voiceLiveApp(ctx, session, []string{"slack"}, args.Account)
	if output != "" || err != nil {
		return output, err
	}
	call := func(slug string, arguments map[string]any) (map[string]any, string, error) {
		return s.voiceLiveAppCall(ctx, app, request, slug, arguments)
	}
	self, output, err := s.voiceLiveSlackSelf(ctx, app, call)
	if output != "" || err != nil {
		return output, err
	}
	filter := " after:" + after
	if person := strings.TrimSpace(args.Person); person != "" {
		sender, _, output, err := s.voiceLiveSlackPerson(ctx, session, call, person)
		if output != "" || err != nil {
			return output, err
		}
		filter += " from:<@" + sender + ">"
	}
	queries := []string{"is:dm" + filter, "<@" + self + ">" + filter}
	found := make([][]map[string]any, len(queries))
	outputs := make([]string, len(queries))
	errs := make([]error, len(queries))
	var wait sync.WaitGroup
	for index, query := range queries {
		wait.Add(1)
		go func() {
			defer wait.Done()
			raw, output, err := call("SLACK_SEARCH_MESSAGES", map[string]any{
				"query": query, "count": voicelive.AppResultLimit, "cursor": "*",
				"sort": "timestamp", "sort_dir": "desc", "highlight": false, "auto_paginate": false,
			})
			list, ok := voicelive.ListRows(voiceLiveRecord(raw["messages"]), "matches")
			if output == "" && err == nil && !ok {
				output = voicelive.ErrorOutput("incomplete_response")
			}
			found[index], outputs[index], errs[index] = list, output, err
		}()
	}
	wait.Wait()
	for index := range queries {
		if outputs[index] != "" || errs[index] != nil {
			return outputs[index], errs[index]
		}
	}
	return voicelive.Output(map[string]any{"messages": voicelive.SlackInbox(found[0], found[1], self)}), nil
}

// voiceLiveSlackChannel resolves a #name to its one channel ID; an ID is
// returned as is.
// voiceLiveSlackSelf is the Slack user the connection was identified as;
// Slack is asked only when the connection never recorded it.
func (s *Service) voiceLiveSlackSelf(ctx context.Context, app voiceLiveAppSession, call voiceLiveSlackCall) (string, string, error) {
	self, err := s.queries.GetVoiceLiveSlackUser(ctx, app.connection.ConnectionID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", "", err
	}
	if self != "" {
		return self, "", nil
	}
	identity, output, err := call("SLACK_TEST_AUTH", map[string]any{})
	if output != "" || err != nil {
		return "", output, err
	}
	if self, _ = identity["user_id"].(string); self == "" {
		return "", voicelive.ErrorOutput("incomplete_response"), nil
	}
	return self, "", nil
}

// voiceLiveSlackSelfDM opens the user's own DM once per connection.
func (s *Service) voiceLiveSlackSelfDM(ctx context.Context, app voiceLiveAppSession, call voiceLiveSlackCall) (string, string, error) {
	if channel, ok := s.slackSelfDMs.Load(app.connection.ConnectionID); ok {
		return channel.(string), "", nil
	}
	self, output, err := s.voiceLiveSlackSelf(ctx, app, call)
	if output != "" || err != nil {
		return "", output, err
	}
	channel, output, err := voiceLiveSlackDM(call, self)
	if output == "" && err == nil {
		s.slackSelfDMs.Store(app.connection.ConnectionID, channel)
	}
	return channel, output, err
}

// voiceLiveSlackDM opens the DM with one Slack user.
func voiceLiveSlackDM(call voiceLiveSlackCall, userID string) (string, string, error) {
	opened, output, err := call("SLACK_OPEN_DM", map[string]any{"users": userID, "return_im": true})
	if output != "" || err != nil {
		return "", output, err
	}
	channel, _ := voiceLiveRecord(opened["channel"])["id"].(string)
	if channel == "" {
		return "", voicelive.ErrorOutput("dm_unavailable"), nil
	}
	return channel, "", nil
}

func voiceLiveSlackChannel(call voiceLiveSlackCall, channel string) (string, string, error) {
	name, ok := strings.CutPrefix(channel, "#")
	if !ok {
		return channel, "", nil
	}
	raw, output, err := call("SLACK_FIND_CHANNELS", map[string]any{
		"query": name, "exact_match": true, "types": "public_channel,private_channel", "exclude_archived": true,
	})
	if output != "" || err != nil {
		return "", output, err
	}
	found, _ := voicelive.ListRows(raw, "channels")
	id := ""
	for _, candidate := range found {
		if candidate["name"] == name && candidate["is_archived"] != true {
			if id != "" {
				return "", voicelive.ErrorOutput("channel_ambiguous"), nil
			}
			id, _ = candidate["id"].(string)
		}
	}
	if id == "" {
		return "", voicelive.ErrorOutput("channel_not_found"), nil
	}
	return id, "", nil
}

// voiceLiveSlackPerson finds a colleague the user named, or an email they
// gave, on Slack by email: the Slack user ID and how to name them.
func (s *Service) voiceLiveSlackPerson(ctx context.Context, session voicelive.Session, call voiceLiveSlackCall, person string) (userID, name, output string, err error) {
	email, name := person, person
	if !voicelive.IsEmailAddress(person) {
		rows, err := s.queries.ListActorsForTenantAccount(ctx, store.ListActorsForTenantAccountParams{
			AccountID: session.AccountID, TenantID: session.TenantID, PageLimit: 500,
		})
		if err != nil {
			return "", "", "", err
		}
		emails := map[string]string{}
		directory := make([]voicelive.DirectoryActor, 0, len(rows))
		for _, row := range rows {
			if row.Kind == "human" && row.AccountEmail.Valid && row.AccountEmail.String != "" {
				emails[row.ID] = row.AccountEmail.String
				directory = append(directory, voicelive.DirectoryActor{ID: row.ID, Name: strings.TrimSpace(row.DisplayName), Kind: row.Kind})
			}
		}
		match := voicelive.MatchMembers([]string{person}, directory, session.HumanActorID)
		switch {
		case match.Problem != nil && match.Problem["error"] == "member_ambiguous":
			return "", "", voicelive.Output(map[string]any{"error": "person_ambiguous", "name": person, "candidates": match.Problem["candidates"]}), nil
		case match.Problem != nil || len(match.IDs) == 0:
			return "", "", voicelive.Output(map[string]string{"error": "person_not_found", "name": person}), nil
		}
		email, name = emails[match.IDs[0]], match.Names[0]
	}
	raw, output, err := call("SLACK_FIND_USER_BY_EMAIL_ADDRESS", map[string]any{"email": email})
	if strings.Contains(output, "not_found") {
		return "", "", voicelive.Output(map[string]string{"error": "slack_user_not_found", "name": name}), nil
	}
	if output != "" || err != nil {
		return "", "", output, err
	}
	user := voiceLiveRecord(raw["user"])
	userID, _ = user["id"].(string)
	address, _ := voiceLiveRecord(user["profile"])["email"].(string)
	if userID == "" || !strings.EqualFold(address, email) {
		return "", "", voicelive.Output(map[string]string{"error": "slack_user_not_found", "name": name}), nil
	}
	return userID, name, "", nil
}
