package voice

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// voiceLiveAgentCredentialTTL bounds the Agent credential one canvas tool
// call acts with; it never leaves TeamHub.
const voiceLiveAgentCredentialTTL = 10 * time.Minute

// voiceLiveCanvasTextRunes bounds the canvas text a changed canvas returns.
const voiceLiveCanvasTextRunes = 8000

var (
	errVoiceLiveAgentUnavailable = errors.New("live Agent has no active registration")
	errNotEmailCanvas            = errors.New("document is not a Gmail canvas")
)

// voiceLiveAgentPrincipal lets a canvas tool act as the call's Agent, the
// identity its CLI writes canvases with.
func (s *Service) voiceLiveAgentPrincipal(ctx context.Context, session voicelive.Session) (agentcredential.Principal, error) {
	principal, _, err := s.voiceLiveAgent(ctx, session)
	return principal, err
}

// voiceLiveAgent also returns the credential's token, which connected-app
// calls authorize with.
func (s *Service) voiceLiveAgent(ctx context.Context, session voicelive.Session) (agentcredential.Principal, string, error) {
	agent, err := s.queries.GetVoiceLiveAgentComputer(ctx, store.GetVoiceLiveAgentComputerParams{ActorID: session.Agent.ID, TenantID: session.TenantID})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && agent.AgentManagementID == "" {
		return agentcredential.Principal{}, "", errVoiceLiveAgentUnavailable
	}
	if err != nil {
		return agentcredential.Principal{}, "", err
	}
	issued, err := agentcredential.New(s.pool).IssueManagedFor(ctx, agent.AgentManagementID, "voice-live:"+session.ID, voiceLiveAgentCredentialTTL)
	if errors.Is(err, agentcredential.ErrForbidden) {
		return agentcredential.Principal{}, "", errVoiceLiveAgentUnavailable
	}
	if err != nil {
		return agentcredential.Principal{}, "", err
	}
	principal, err := agentcredential.Authenticate(ctx, s.pool, issued.AccessToken)
	return principal, issued.AccessToken, err
}

// voiceLiveInvocationID names one tool call for idempotent Document writes.
func voiceLiveInvocationID(session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) string {
	digest := sha256.Sum256([]byte(session.ID + "\x00" + request.CallId))
	return "voice_live_" + hex.EncodeToString(digest[:16])
}

// openVoiceLiveEmailCanvas writes the email as a Gmail canvas the Agent owns
// in the call's Room and opens it there, as the canvas Skill does.
func (s *Service) openVoiceLiveEmailCanvas(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.EmailCanvasArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	canvas, problem := voicelive.EmailCanvas(args)
	if problem != "" {
		return voicelive.ErrorOutput(problem), nil
	}
	created, output, err := s.openVoiceLiveCanvas(ctx, session, request, canvas.Title, canvas.Markdown, "invalid_email")
	if output != "" || err != nil {
		return output, err
	}
	return voicelive.Output(map[string]string{
		"status": "opened", "document_id": created.DocumentID, "revision_id": created.RevisionID,
		"next": "First tell the user in one short sentence what the email says: its subject and main points, in your own words. Then say it is open beside the chat for them to change, and only then ask for anything missing, such as a recipient.",
	}), nil
}

// openVoiceLiveCanvas creates a Document the Agent owns in the call's Room
// and opens it beside the chat with the Agent's canvas message. invalid is
// what the live model is told when TeamHub refuses the title or body.
func (s *Service) openVoiceLiveCanvas(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, title, markdown, invalid string) (document.CreateAgentDocumentResult, string, error) {
	principal, err := s.voiceLiveAgentPrincipal(ctx, session)
	if errors.Is(err, errVoiceLiveAgentUnavailable) {
		return document.CreateAgentDocumentResult{}, voicelive.ErrorOutput("agent_unavailable"), nil
	}
	if err != nil {
		return document.CreateAgentDocumentResult{}, "", err
	}
	created, err := s.documents.CreateAgentDocument(ctx, document.CreateAgentDocumentInput{
		Principal: &principal, TargetKind: "room", TargetID: session.RoomID,
		SourceInvocationID: voiceLiveInvocationID(session, request),
		Title:              title, Markdown: markdown,
	})
	if errors.Is(err, document.ErrInvalidInput) {
		return created, voicelive.ErrorOutput(invalid), nil
	}
	if errors.Is(err, document.ErrNotFound) {
		return created, voicelive.ErrorOutput("agent_unavailable"), nil
	}
	if err != nil {
		return created, "", err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return created, "", err
	}
	defer tx.Rollback(ctx)
	// A call that already handed over cannot post into the Room any more.
	current, err := s.queries.WithTx(tx).LockVoiceLiveSessionCurrent(ctx, session.ID)
	if err != nil {
		return created, "", err
	}
	if !current {
		return created, "", voicelive.ErrNotFound
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{{
		Type: "document", Content: title, DocumentID: created.DocumentID, Presentation: "canvas",
	}})
	if err != nil {
		return created, "", err
	}
	if _, err = messagecreation.Create(ctx, store.New(tx), messagecreation.Draft{
		TenantID: session.TenantID, RoomID: session.RoomID, Author: session.Agent, Content: content, SuppressMentionSignals: true,
	}); err != nil {
		return created, "", err
	}
	return created, "", tx.Commit(ctx)
}

// editVoiceLiveEmailCanvas replaces the canvas with the changed email as
// the Agent, only when it is still the revision the live model last saw:
// the user's own edits in between are returned to it, never overwritten.
func (s *Service) editVoiceLiveEmailCanvas(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.EditEmailCanvasArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil || args.DocumentID == "" {
		return "", voicelive.ErrInvalid
	}
	principal, err := s.voiceLiveAgentPrincipal(ctx, session)
	if errors.Is(err, errVoiceLiveAgentUnavailable) {
		return voicelive.ErrorOutput("agent_unavailable"), nil
	}
	if err != nil {
		return "", err
	}
	canvas, err := s.voiceLiveCanvas(ctx, principal, args.DocumentID)
	if output, handled := voiceLiveCanvasError(err); handled {
		return output, nil
	}
	if err != nil {
		return "", err
	}
	// A body rewrite is text: it replaces the text blocks and keeps the
	// attached files after them. Images or files among the text would be
	// lost, so that body changes through a task; the header can always change.
	if args.Body != nil && canvas.mediaInText {
		return voicelive.ErrorOutput("canvas_has_media"), nil
	}
	if args.RevisionID != canvas.revisionID {
		return canvas.changed(), nil
	}
	if args.Body != nil {
		// The model may copy an attachment line from the body it was shown.
		body := voiceLiveAttachmentLine.ReplaceAllString(*args.Body, "")
		args.Body = &body
	}
	_, header, problem := voicelive.EditedEmailCanvas(canvas.fields, canvas.text, args)
	if problem != "" {
		return voicelive.ErrorOutput(problem), nil
	}
	// A native edit is one operation: the header, the title and the body's
	// text change in turn, each against the revision the one before made.
	edits := []map[string]string{}
	if args.To != nil || args.Cc != nil || args.Subject != nil {
		edits = append(edits, map[string]string{"command": "block_replace", "block_id": canvas.firstBlockID, "content": header})
	}
	if args.Subject != nil && voicelive.EmailCanvasTitle(*args.Subject) != voicelive.EmailCanvasTitle(canvas.fields["subject"]) {
		// The canvas is named after its email, as open_email_canvas names it.
		edits = append(edits, map[string]string{"command": "set_title", "title": voicelive.EmailCanvasTitle(*args.Subject)})
	}
	if args.Body != nil {
		// The other text runs go first, last to first, and the attachments
		// between them stay; the new text then takes the first text's place,
		// or follows the header when an attachment comes first.
		body := strings.TrimSpace(*args.Body) + "\n"
		runs := canvas.textRuns
		replace := len(runs) > 0 && !canvas.attachmentFirst
		kept := 0
		if replace {
			kept = 1
		}
		for index := len(runs) - 1; index >= kept; index-- {
			edits = append(edits, voiceLiveRunEdit("block_delete", runs[index]))
		}
		if replace {
			edit := voiceLiveRunEdit("block_replace", runs[0])
			edit["content"] = body
			edits = append(edits, edit)
		} else {
			edits = append(edits, map[string]string{"command": "block_insert_after", "block_id": canvas.firstBlockID, "content": body})
		}
	}
	if len(edits) == 0 {
		return voicelive.ErrorOutput("invalid_email"), nil
	}
	revisionID := canvas.revisionID
	for index, edit := range edits {
		edit["kind"], edit["parser_version"] = "edit_document", "markdown-v1"
		change, err := json.Marshal([]map[string]string{edit})
		if err != nil {
			return "", err
		}
		invocationID := voiceLiveInvocationID(session, request)
		if index > 0 {
			invocationID += "_" + strconv.Itoa(index)
		}
		result, err := s.documents.ApplySemanticMutation(ctx, document.ApplySemanticMutationInput{
			Principal: &principal, TargetKind: "room", TargetID: session.RoomID,
			DocumentID: args.DocumentID, SourceInvocationID: invocationID,
			SchemaVersion: "blocknote-semantic-v1", ExpectedRevisionID: revisionID, SemanticChange: change,
		})
		switch {
		case errors.Is(err, document.ErrVersionConflict), errors.Is(err, document.ErrConflict),
			err == nil && result.Status == document.SemanticMutationConflicted:
			// The user edited it while the change was made: hand back the latest.
			latest, readErr := s.voiceLiveCanvas(ctx, principal, args.DocumentID)
			if output, handled := voiceLiveCanvasError(readErr); handled {
				return output, nil
			}
			if readErr != nil {
				return "", readErr
			}
			return latest.changed(), nil
		case errors.Is(err, document.ErrInvalidInput):
			// Block edits cannot keep comments anchored in the canvas.
			return voicelive.ErrorOutput("canvas_locked"), nil
		case err != nil:
			return "", err
		}
		revisionID = result.RevisionID
	}
	return voicelive.Output(map[string]string{
		"status": "changed", "document_id": args.DocumentID, "revision_id": revisionID,
		"next": "Tell the user in one short sentence what you changed in the email.",
	}), nil
}

// attachVoiceLiveEmailFile copies a file the Agent reads (a Document in a
// Room or the Library, or a task's output) into the canvas as an attachment
// after its last block, so the draft or send carries it.
func (s *Service) attachVoiceLiveEmailFile(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.AttachEmailFileArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	canvasID, fileID := strings.TrimSpace(args.DocumentID), strings.TrimSpace(args.FileDocumentID)
	taskID, file := strings.TrimSpace(args.TaskID), strings.TrimSpace(args.File)
	if canvasID == "" || (fileID == "") == (taskID == "") || file != "" && taskID == "" {
		return "", voicelive.ErrInvalid
	}
	principal, err := s.voiceLiveAgentPrincipal(ctx, session)
	if errors.Is(err, errVoiceLiveAgentUnavailable) {
		return voicelive.ErrorOutput("agent_unavailable"), nil
	}
	if err != nil {
		return "", err
	}
	canvas, err := s.voiceLiveCanvas(ctx, principal, canvasID)
	if output, handled := voiceLiveCanvasError(err); handled {
		return output, nil
	}
	if err != nil {
		return "", err
	}
	attachment, output, err := s.voiceLiveFileAttachment(ctx, session, principal, fileID, taskID, file)
	if output != "" || err != nil {
		return output, err
	}
	name := strings.Join(strings.Fields(attachment.name), " ")
	if runes := []rune(name); len(runes) > 255 {
		name = string(runes[:255])
	}
	invocationID := voiceLiveInvocationID(session, request)
	asset, err := s.documents.CreateAgentAsset(ctx, document.CreateAgentAssetInput{
		TenantID: principal.TenantID, AgentID: principal.AgentID, DocumentID: canvasID,
		Filename: name, OperationID: invocationID, Contents: bytes.NewReader(attachment.content),
	})
	switch {
	case errors.Is(err, document.ErrAssetQuotaExceeded):
		return voicelive.ErrorOutput("file_too_large"), nil
	case errors.Is(err, document.ErrInvalidInput):
		return voicelive.ErrorOutput("file_not_supported"), nil
	case errors.Is(err, document.ErrNotFound):
		return voicelive.ErrorOutput("document_not_found"), nil
	case err != nil:
		return "", err
	}
	// The file goes after the canvas's last block, whatever the user changed
	// meanwhile; a last block they just deleted is read again once.
	for attempt := 0; ; attempt++ {
		change, err := json.Marshal([]map[string]string{{
			"kind": "edit_document", "parser_version": "markdown-v1", "command": "file_insert_after",
			"block_id": canvas.lastBlockID, "asset_id": asset.Asset.ID, "name": name,
		}})
		if err != nil {
			return "", err
		}
		result, err := s.documents.ApplySemanticMutation(ctx, document.ApplySemanticMutationInput{
			Principal: &principal, TargetKind: "room", TargetID: session.RoomID,
			DocumentID: canvasID, SourceInvocationID: invocationID + strings.Repeat("_retry", attempt),
			SchemaVersion: "blocknote-semantic-v1", SemanticChange: change,
		})
		conflicted := errors.Is(err, document.ErrVersionConflict) || errors.Is(err, document.ErrConflict) ||
			err == nil && result.Status == document.SemanticMutationConflicted
		switch {
		case conflicted && attempt == 0:
			if canvas, err = s.voiceLiveCanvas(ctx, principal, canvasID); err != nil {
				if output, handled := voiceLiveCanvasError(err); handled {
					return output, nil
				}
				return "", err
			}
			continue
		case conflicted:
			// The user keeps editing it: hand back the canvas as it is now.
			latest, readErr := s.voiceLiveCanvas(ctx, principal, canvasID)
			if output, handled := voiceLiveCanvasError(readErr); handled {
				return output, nil
			}
			if readErr != nil {
				return "", readErr
			}
			return latest.changed(), nil
		case errors.Is(err, document.ErrInvalidInput):
			return voicelive.ErrorOutput("canvas_locked"), nil
		case err != nil:
			return "", err
		}
		return voicelive.Output(map[string]any{
			"status": "attached", "document_id": canvasID, "revision_id": result.RevisionID,
			"attached": name, "attachments": append(canvas.attachments, name),
			"next": "Tell the user in one short sentence that the file is attached to the email.",
		}), nil
	}
}

// voiceLiveRunEdit names a run of sibling blocks for a block edit.
func voiceLiveRunEdit(command string, run []string) map[string]string {
	if len(run) == 1 {
		return map[string]string{"command": command, "block_id": run[0]}
	}
	return map[string]string{"command": command, "start_block_id": run[0], "end_block_id": run[len(run)-1]}
}

func voiceLiveCanvasError(err error) (string, bool) {
	switch {
	case errors.Is(err, document.ErrNotFound):
		return voicelive.ErrorOutput("document_not_found"), true
	case errors.Is(err, errNotEmailCanvas):
		return voicelive.ErrorOutput("not_email_canvas"), true
	}
	return "", false
}

// voiceLiveCanvasState is one revision of a canvas as the Agent reads it.
type voiceLiveCanvasState struct {
	documentID, revisionID, firstBlockID, lastBlockID string
	hasMedia                                          bool
	fields                                            map[string]string
	// body is the Markdown after the header, attachment lines included.
	body string
	// text is the body without its attachment lines: what the email says.
	text string
	// textRuns are the body's text blocks, in runs between attachments.
	textRuns [][]string
	// attachmentFirst is an attachment right after the header.
	attachmentFirst bool
	// attachments names the files the email attaches, in canvas order.
	attachments []string
	// mediaInText is an image among the text, or media inside a text block,
	// which a text rewrite of the body would lose.
	mediaInText bool
}

// voiceLiveAttachmentLine is one attachment as the Markdown export writes a
// file block: a whole line linking a Document Asset.
var voiceLiveAttachmentLine = regexp.MustCompile(`(?m)^[ \t]*\[[^\n]*\]\(document-asset:[A-Za-z0-9][A-Za-z0-9_-]{0,63}\)[ \t]*\n?`)

// draftDigest names what a draft saved from the canvas contains: its
// recipients, subject and body. The draft's own MIME boundary differs on
// every save, so the raw message cannot say whether the content changed.
func (c voiceLiveCanvasState) draftDigest() string {
	sum := sha256.Sum256([]byte(strings.Join([]string{c.fields["to"], c.fields["cc"], c.fields["subject"], c.body}, "\x00")))
	return hex.EncodeToString(sum[:])
}

// changed tells the live model the canvas is not as it last saw it.
func (c voiceLiveCanvasState) changed() string {
	body, truncated := voicelive.Truncate(c.text, voiceLiveCanvasTextRunes)
	output := map[string]any{
		"error": "canvas_changed", "revision_id": c.revisionID,
		"to": c.fields["to"], "cc": c.fields["cc"], "subject": c.fields["subject"], "body": body,
		"attachments": c.attachments,
	}
	if truncated {
		output["truncated"] = true
	}
	return voicelive.Output(output)
}

type voiceLiveCanvasBlock struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Props struct {
		Name string `json:"name"`
	} `json:"props"`
	Children []voiceLiveCanvasBlock `json:"children"`
}

func voiceLiveMediaBlock(block voiceLiveCanvasBlock) bool {
	switch block.Type {
	case "image", "file", "video", "audio":
		return true
	}
	return false
}

// voiceLiveCanvasBody splits a canvas's blocks after its header into runs
// of text and the attachments around them. A file, video or audio block is
// an attachment wherever it sits; an image is one only after all the text,
// since an image among the text is part of what the email shows.
func voiceLiveCanvasBody(blocks []voiceLiveCanvasBlock) (runs [][]string, attachmentFirst bool, attachments []string, mediaInText bool) {
	if len(blocks) < 2 {
		return nil, false, nil, false
	}
	body := blocks[1:]
	end := len(body)
	for end > 0 && voiceLiveMediaBlock(body[end-1]) && len(body[end-1].Children) == 0 {
		end--
	}
	attachment := func(index int) bool {
		block := body[index]
		if !voiceLiveMediaBlock(block) || len(block.Children) > 0 {
			return false
		}
		return index >= end || block.Type != "image"
	}
	var run []string
	for index, block := range body {
		if attachment(index) {
			if run != nil {
				runs, run = append(runs, run), nil
			}
			name := block.Props.Name
			if name == "" {
				name = block.Type
			}
			attachments = append(attachments, name)
			continue
		}
		run = append(run, block.ID)
		mediaInText = mediaInText || voiceLiveMediaBlock(block) || voiceLiveMedia(block.Children)
	}
	if run != nil {
		runs = append(runs, run)
	}
	return runs, attachment(0), attachments, mediaInText
}

// voiceLiveMedia says whether blocks hold an image or a file (an email
// canvas's attachment): a text rewrite of the body would turn them into text.
func voiceLiveMedia(blocks []voiceLiveCanvasBlock) bool {
	for _, block := range blocks {
		switch block.Type {
		case "image", "file", "video", "audio":
			return true
		}
		if voiceLiveMedia(block.Children) {
			return true
		}
	}
	return false
}

// voiceLiveDocumentState is one revision of a Document as the Agent reads it.
type voiceLiveDocumentState struct {
	documentID, revisionID, firstBlockID, lastBlockID string
	hasMedia                                          bool
	blocks, markdown                                  []byte
}

// voiceLiveDocument reads the latest Document as the Agent. The exports
// carry no revision, so they count only when the body's Revision is the same
// before and after them; a semantic change then names that Revision as its
// base.
func (s *Service) voiceLiveDocument(ctx context.Context, principal agentcredential.Principal, documentID string) (voiceLiveDocumentState, error) {
	head := func() (string, error) {
		revisionID, err := s.queries.SnapshotVoiceLiveCanvasRevision(ctx, store.SnapshotVoiceLiveCanvasRevisionParams{DocumentID: documentID, TenantID: principal.TenantID})
		if errors.Is(err, pgx.ErrNoRows) {
			return "", document.ErrNotFound
		}
		return revisionID, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		before, err := head()
		if err != nil {
			return voiceLiveDocumentState{}, err
		}
		blocksExport, err := s.canvas.CanvasExport(ctx, principal.TenantID, principal.AgentID, documentID, "blocks")
		if err != nil {
			return voiceLiveDocumentState{}, err
		}
		markdown, err := s.canvas.CanvasExport(ctx, principal.TenantID, principal.AgentID, documentID, "markdown")
		if err != nil {
			return voiceLiveDocumentState{}, err
		}
		after, err := head()
		if err != nil {
			return voiceLiveDocumentState{}, err
		}
		if before != after {
			continue
		}
		var idBlocks struct {
			Blocks []voiceLiveCanvasBlock `json:"blocks"`
		}
		if json.Unmarshal(blocksExport, &idBlocks) != nil {
			return voiceLiveDocumentState{}, document.ErrRevisionUnavailable
		}
		state := voiceLiveDocumentState{
			documentID: documentID, revisionID: after, hasMedia: voiceLiveMedia(idBlocks.Blocks),
			blocks: blocksExport, markdown: markdown,
		}
		if len(idBlocks.Blocks) > 0 {
			state.firstBlockID, state.lastBlockID = idBlocks.Blocks[0].ID, idBlocks.Blocks[len(idBlocks.Blocks)-1].ID
		}
		return state, nil
	}
	return voiceLiveDocumentState{}, document.ErrRevisionUnavailable
}

// voiceLiveCanvas reads the latest Gmail canvas as the Agent.
func (s *Service) voiceLiveCanvas(ctx context.Context, principal agentcredential.Principal, documentID string) (voiceLiveCanvasState, error) {
	state, err := s.voiceLiveDocument(ctx, principal, documentID)
	if err != nil {
		return voiceLiveCanvasState{}, err
	}
	var headerBlocks struct {
		Blocks []agentconnectedapps.CanvasBlock `json:"blocks"`
	}
	var idBlocks struct {
		Blocks []voiceLiveCanvasBlock `json:"blocks"`
	}
	if json.Unmarshal(state.blocks, &headerBlocks) != nil || json.Unmarshal(state.blocks, &idBlocks) != nil || state.firstBlockID == "" {
		return voiceLiveCanvasState{}, errNotEmailCanvas
	}
	runs, attachmentFirst, attachments, mediaInText := voiceLiveCanvasBody(idBlocks.Blocks)
	body := agentconnectedapps.CanvasHeaderFence.ReplaceAllString(string(state.markdown), "")
	header, ok := agentconnectedapps.ReadCanvasHeader(headerBlocks.Blocks)
	if !ok || header.Target != "gmail" {
		return voiceLiveCanvasState{}, errNotEmailCanvas
	}
	return voiceLiveCanvasState{
		documentID: documentID, revisionID: state.revisionID, firstBlockID: state.firstBlockID, lastBlockID: state.lastBlockID,
		hasMedia: state.hasMedia, fields: header.Fields, body: body,
		text:     strings.TrimSpace(voiceLiveAttachmentLine.ReplaceAllString(body, "")) + "\n",
		textRuns: runs, attachmentFirst: attachmentFirst, attachments: attachments, mediaInText: mediaInText,
	}, nil
}
