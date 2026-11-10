package voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	teamhubinternal "github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// The live voice renames and edits Documents as the call's Agent, with the
// native edits the Agent's CLI makes, and comments as the user, through the
// Comment commands the side panel uses.

const (
	voiceLiveCommentThreads  = 20
	voiceLiveThreadComments  = 5
	voiceLiveCommentRunes    = 500
	voiceLiveCommentContexts = 2000
)

func (s *Service) runVoiceLiveDocumentTool(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.DocumentArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	args.DocumentID, args.ThreadID = strings.TrimSpace(args.DocumentID), strings.TrimSpace(args.ThreadID)
	switch request.Name {
	case voicelive.ToolCreateDocument:
		title, ok := voicelive.DocumentTitle(args.Title)
		if !ok || utf8.RuneCountInString(args.Content) > voicelive.MaxCreateDocumentRunes {
			return "", voicelive.ErrInvalid
		}
		created, output, err := s.openVoiceLiveCanvas(ctx, session, request, title, strings.TrimSpace(args.Content), "invalid_document")
		if output != "" || err != nil {
			return output, err
		}
		return voicelive.Output(map[string]string{"status": "created", "document_id": created.DocumentID, "revision_id": created.RevisionID}), nil
	case voicelive.ToolRenameDocument, voicelive.ToolEditDocument, voicelive.ToolReplaceDocumentText:
		if args.DocumentID == "" {
			return "", voicelive.ErrInvalid
		}
		principal, err := s.voiceLiveAgentPrincipal(ctx, session)
		if errors.Is(err, errVoiceLiveAgentUnavailable) {
			return voicelive.ErrorOutput("agent_unavailable"), nil
		}
		if err != nil {
			return "", err
		}
		if request.Name == voicelive.ToolRenameDocument {
			return s.renameVoiceLiveDocument(ctx, session, request, principal, args)
		}
		if request.Name == voicelive.ToolReplaceDocumentText {
			args.Command = "replace_text"
		} else if args.Command == "replace_text" {
			return voicelive.ErrorOutput("invalid_command"), nil
		}
		return s.editVoiceLiveDocument(ctx, session, request, principal, args)
	case voicelive.ToolListComments:
		return s.listVoiceLiveComments(ctx, session, args)
	case voicelive.ToolAddComment:
		return s.addVoiceLiveComment(ctx, session, request, args)
	case voicelive.ToolReplyComment:
		return s.replyVoiceLiveComment(ctx, session, request, args)
	case voicelive.ToolResolveComment:
		return s.resolveVoiceLiveComment(ctx, session, request, args)
	}
	return voicelive.ErrorOutput("unknown_tool"), nil
}

// applyVoiceLiveDocumentEdit applies one native edit as the Agent; output is
// what the live model is told when it did not apply.
func (s *Service) applyVoiceLiveDocumentEdit(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, principal agentcredential.Principal, documentID, expectedRevisionID string, edit map[string]string) (document.SemanticMutationResult, string, error) {
	change, err := json.Marshal([]map[string]string{edit})
	if err != nil {
		return document.SemanticMutationResult{}, "", err
	}
	result, err := s.documents.ApplySemanticMutation(ctx, document.ApplySemanticMutationInput{
		Principal: &principal, TargetKind: "room", TargetID: session.RoomID,
		DocumentID: documentID, SourceInvocationID: voiceLiveInvocationID(session, request),
		SchemaVersion: "blocknote-semantic-v1", ExpectedRevisionID: expectedRevisionID, SemanticChange: change,
	})
	switch {
	case errors.Is(err, document.ErrNotFound):
		return result, voicelive.ErrorOutput("document_not_editable"), nil
	case errors.Is(err, document.ErrVersionConflict), errors.Is(err, document.ErrConflict):
		return result, voicelive.ErrorOutput("document_changed"), nil
	case errors.Is(err, document.ErrInvalidInput):
		// Block edits cannot keep comments anchored in what they replace.
		return result, voicelive.ErrorOutput("document_locked"), nil
	case err != nil:
		return result, "", err
	case result.Status == document.SemanticMutationConflicted:
		reason := result.ConflictReason
		if reason != "text_not_found" && reason != "ambiguous_text" {
			reason = "document_changed"
		}
		return result, voicelive.ErrorOutput(reason), nil
	}
	return result, "", nil
}

func (s *Service) renameVoiceLiveDocument(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, principal agentcredential.Principal, args voicelive.DocumentArguments) (string, error) {
	title, ok := voicelive.DocumentTitle(args.Title)
	if !ok {
		return voicelive.ErrorOutput("invalid_title"), nil
	}
	_, output, err := s.applyVoiceLiveDocumentEdit(ctx, session, request, principal, args.DocumentID, "", map[string]string{
		"kind": "edit_document", "parser_version": "markdown-v1", "command": "set_title", "title": title,
	})
	if output != "" || err != nil {
		return output, err
	}
	return voicelive.Output(map[string]string{"status": "renamed", "document_id": args.DocumentID, "title": title}), nil
}

func (s *Service) editVoiceLiveDocument(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, principal agentcredential.Principal, args voicelive.DocumentArguments) (string, error) {
	if args.Command != "rewrite" {
		edit, problem := voicelive.DocumentEdit(args)
		if problem != "" {
			return voicelive.ErrorOutput(problem), nil
		}
		result, output, err := s.applyVoiceLiveDocumentEdit(ctx, session, request, principal, args.DocumentID, "", edit)
		if output != "" || err != nil {
			return output, err
		}
		return voicelive.Output(map[string]string{"status": "changed", "document_id": args.DocumentID, "revision_id": result.RevisionID}), nil
	}
	current, err := s.voiceLiveDocument(ctx, principal, args.DocumentID)
	if errors.Is(err, document.ErrNotFound) {
		return voicelive.ErrorOutput("document_not_found"), nil
	}
	if err != nil {
		return "", err
	}
	text := strings.TrimSpace(string(current.markdown))
	switch {
	case current.hasMedia:
		return voicelive.ErrorOutput("document_has_media"), nil
	case len([]rune(text)) > voicelive.MaxRewriteRunes:
		return voicelive.Output(map[string]string{"error": "too_long_to_rewrite", "detail": "Use append or replace_text, or start_task naming the document_id."}), nil
	case args.RevisionID != current.revisionID || current.firstBlockID == "":
		// The model rewrites only text it has seen at this revision.
		return voicelive.Output(map[string]string{"error": "document_changed", "revision_id": current.revisionID, "text": text,
			"next": "Redo the change on this text and call again with this revision_id."}), nil
	case strings.TrimSpace(args.Content) == "" || len([]rune(args.Content)) > voicelive.MaxRewriteRunes*2:
		return voicelive.ErrorOutput("content_required"), nil
	}
	edit := map[string]string{"kind": "edit_document", "parser_version": "markdown-v1", "command": "block_replace", "content": args.Content}
	if current.firstBlockID == current.lastBlockID {
		edit["block_id"] = current.firstBlockID
	} else {
		edit["start_block_id"], edit["end_block_id"] = current.firstBlockID, current.lastBlockID
	}
	result, output, err := s.applyVoiceLiveDocumentEdit(ctx, session, request, principal, args.DocumentID, current.revisionID, edit)
	if output != "" || err != nil {
		return output, err
	}
	return voicelive.Output(map[string]string{"status": "changed", "document_id": args.DocumentID, "revision_id": result.RevisionID}), nil
}

func voiceLiveCommentError(err error) (string, bool) {
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, document.ErrNotFound):
		return voicelive.ErrorOutput("not_found"), true
	case errors.Is(err, document.ErrCommentForbidden):
		return voicelive.ErrorOutput("comment_not_allowed"), true
	case errors.Is(err, document.ErrCommentInvalidInput), errors.Is(err, document.ErrCommentCapacity):
		return voicelive.ErrorOutput("invalid_comment"), true
	case errors.Is(err, document.ErrCommentConflict):
		return voicelive.ErrorOutput("document_changed"), true
	}
	return "", false
}

func voiceLiveCommentText(text string) []document.Segment {
	return []document.Segment{{Type: "text", Content: strings.TrimSpace(text)}}
}

// listVoiceLiveComments reads the threads the user sees, open ones first.
func (s *Service) listVoiceLiveComments(ctx context.Context, session voicelive.Session, args voicelive.DocumentArguments) (string, error) {
	if args.DocumentID == "" {
		return "", voicelive.ErrInvalid
	}
	page, err := s.documentComments.ListThreads(ctx, session.AccountID, args.DocumentID, "", 100)
	if output, handled := voiceLiveCommentError(err); handled {
		return output, nil
	}
	if err != nil {
		return "", err
	}
	threads := []map[string]any{}
	for _, open := range []bool{true, false} {
		for _, thread := range page.Items {
			if thread.Resolved == open || len(threads) == voiceLiveCommentThreads {
				continue
			}
			comments := []map[string]string{}
			for _, comment := range thread.Comments {
				if comment.DeletedAt != nil {
					continue
				}
				body, _ := voicelive.Truncate(comment.Body, voiceLiveCommentRunes)
				comments = append(comments, map[string]string{"author": comment.Author.DisplayName, "text": body})
			}
			if len(comments) > voiceLiveThreadComments {
				comments = append(comments[:1], comments[len(comments)-voiceLiveThreadComments+1:]...)
			}
			quote, _ := voicelive.Truncate(thread.Anchor.QuotedText, voiceLiveCommentRunes)
			threads = append(threads, map[string]any{"thread_id": thread.ID, "quote": quote, "resolved": thread.Resolved, "comments": comments})
		}
	}
	return voicelive.Output(map[string]any{"document_id": args.DocumentID, "threads": threads}), nil
}

// addVoiceLiveComment comments on a quote as the user once they said yes,
// then attaches it to the quoted text as the side panel does.
func (s *Service) addVoiceLiveComment(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, args voicelive.DocumentArguments) (string, error) {
	if args.DocumentID == "" || strings.TrimSpace(args.Text) == "" {
		return "", voicelive.ErrInvalid
	}
	principal, err := s.voiceLiveAgentPrincipal(ctx, session)
	if errors.Is(err, errVoiceLiveAgentUnavailable) {
		return voicelive.ErrorOutput("agent_unavailable"), nil
	}
	if err != nil {
		return "", err
	}
	current, err := s.voiceLiveDocument(ctx, principal, args.DocumentID)
	if errors.Is(err, document.ErrNotFound) {
		return voicelive.ErrorOutput("document_not_found"), nil
	}
	if err != nil {
		return "", err
	}
	blocks, ok := voicelive.DocumentBlocks(current.blocks)
	if !ok {
		return "", document.ErrRevisionUnavailable
	}
	blockID, problem := voicelive.CommentAnchor(blocks, args.Quote)
	if problem != "" {
		return voicelive.ErrorOutput(problem), nil
	}
	summary := fmt.Sprintf("Comment as you on %q in the document: %q", voicelive.Snippet(args.Quote), strings.TrimSpace(args.Text))
	confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), summary+"\x00"+args.DocumentID)
	if err != nil {
		return "", err
	}
	if !confirmed {
		return voicelive.NeedsConfirmation(summary), nil
	}
	created, err := s.documentComments.CreateThread(ctx, document.CreateThreadInput{
		AccountID: session.AccountID, DocumentID: args.DocumentID,
		Anchor:   &document.AnchorInput{QuotedText: args.Quote, BlockID: blockID},
		Segments: voiceLiveCommentText(args.Text),
	})
	if output, handled := voiceLiveCommentError(err); handled {
		return output, nil
	}
	if err != nil {
		return "", err
	}
	// The side panel marks the quoted text in the body it last saw; this is
	// the latest, read again if a save lands in between.
	for range 3 {
		var body store.GetVoiceLiveDocumentBodyStateRow
		body, err = s.queries.GetVoiceLiveDocumentBodyState(ctx, store.GetVoiceLiveDocumentBodyStateParams{
			DocumentID: args.DocumentID, TenantID: session.TenantID,
		})
		if err != nil {
			return "", err
		}
		_, err = s.documentComments.AttachSelectionAnchor(ctx, document.AnchorAttachmentInput{
			AccountID: session.AccountID, ThreadID: created.Thread.ID,
			ExpectedPersistedSeq: body.Seq, ExpectedFullStateFingerprint: body.Fingerprint,
		})
		if !errors.Is(err, document.ErrCommentConflict) {
			break
		}
	}
	if err != nil && s.logger != nil {
		// The comment stands; the side panel attaches a pending anchor itself.
		s.logger.Warn("live comment anchor not attached", "voice_session_id", session.ID, "thread_id", created.Thread.ID, "error_type", fmt.Sprintf("%T", err))
	}
	return voicelive.Output(map[string]string{"status": "commented", "thread_id": created.Thread.ID}), nil
}

func (s *Service) replyVoiceLiveComment(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, args voicelive.DocumentArguments) (string, error) {
	if args.ThreadID == "" || strings.TrimSpace(args.Text) == "" {
		return "", voicelive.ErrInvalid
	}
	thread, err := s.documentComments.GetThread(ctx, session.AccountID, args.ThreadID)
	if output, handled := voiceLiveCommentError(err); handled {
		return output, nil
	}
	if err != nil {
		return "", err
	}
	summary := fmt.Sprintf("Reply as you in the comment thread on %q: %q", voicelive.Snippet(thread.Anchor.QuotedText), strings.TrimSpace(args.Text))
	confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), summary+"\x00"+args.ThreadID)
	if err != nil {
		return "", err
	}
	if !confirmed {
		return voicelive.NeedsConfirmation(summary), nil
	}
	reply, err := s.documentComments.Reply(ctx, document.ReplyInput{
		AccountID: session.AccountID, ThreadID: args.ThreadID,
		Segments: voiceLiveCommentText(args.Text),
	})
	if output, handled := voiceLiveCommentError(err); handled {
		return output, nil
	}
	if err != nil {
		return "", err
	}
	return voicelive.Output(map[string]string{"status": "replied", "thread_id": args.ThreadID, "comment_id": reply.Comment.ID}), nil
}

func (s *Service) resolveVoiceLiveComment(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall, args voicelive.DocumentArguments) (string, error) {
	if args.ThreadID == "" {
		return "", voicelive.ErrInvalid
	}
	input := document.ResolutionInput{AccountID: session.AccountID, ThreadID: args.ThreadID}
	resolve, status := s.documentComments.Resolve, "resolved"
	if bool(args.Reopen) {
		resolve, status = s.documentComments.Reopen, "reopened"
	}
	_, err := resolve(ctx, input)
	if output, handled := voiceLiveCommentError(err); handled {
		return output, nil
	}
	if err != nil {
		return "", err
	}
	return voicelive.Output(map[string]string{"status": status, "thread_id": args.ThreadID}), nil
}
