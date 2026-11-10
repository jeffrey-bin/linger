// Document Revision inputs are immutable inputs prepared for Agent Runs.

package document

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var (
	ErrStaleHead = errors.New("Document Revision Input head is stale")
)

const (
	maxDocumentNotificationMarkdownBytes = 262144
	maxDocumentCommentsMarkdownBytes     = 4 * 1024 * 1024
	maxNotificationCommentTextBytes      = 4096
	maxNotificationSelectionBytes        = 32768
	maxNotificationContextBytes          = 512
)

type HeadSelector struct {
	PersistedSeq     int64
	StateHash        string
	StateHashVersion int32
}

type MentionInput struct {
	TenantID       string
	RoomID         string
	DocumentID     string
	ThreadID       string
	CommentID      string
	CommentVersion int64
	AgentActorID   string
	Head           HeadSelector
}

func CreateForMention(ctx context.Context, tx pgx.Tx, input MentionInput) error {
	var agentManagementID string
	if err := tx.QueryRow(ctx, `SELECT registration.agent_management_id
		FROM agent_registrations registration
		WHERE registration.actor_id=$1 AND registration.tenant_id=$2
		  AND registration.status='active' AND registration.agent_management_id IS NOT NULL`,
		input.AgentActorID, input.TenantID).Scan(&agentManagementID); err != nil {
		return err
	}
	if input.Head.StateHashVersion != 1 {
		return ErrStaleHead
	}
	err := tx.QueryRow(ctx, `SELECT document.id
		FROM documents document
		JOIN document_bodies body ON body.document_id=document.id
		LEFT JOIN document_context_bindings binding ON binding.document_id=document.id
		 AND binding.tenant_id=document.tenant_id AND binding.binding_kind='room'
		 AND binding.room_id=$3 AND binding.status='active'
		WHERE document.id=$1 AND document.tenant_id=$2 AND document.status='active'
		 AND document.format='blocknote'
		 AND ($3='' OR binding.id IS NOT NULL)
		 AND body.seq=$5 AND encode(sha256(body.state),'hex')=$6
		 AND (
		   EXISTS (
		     SELECT 1 FROM active_room_members agent
		     WHERE agent.room_id=binding.room_id AND agent.tenant_id=binding.tenant_id
		       AND agent.actor_id=$4
		   )
		   OR document_comment_agent_readable(document.tenant_id,document.id,$4)
		 )`,
		input.DocumentID, input.TenantID, input.RoomID, input.AgentActorID,
		input.Head.PersistedSeq, input.Head.StateHash).Scan(new(string))
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrStaleHead
	}
	if err != nil {
		return err
	}
	projection, err := buildDocumentCommentNotification(ctx, tx, input)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrCommentConflict
	}
	if err != nil {
		return err
	}
	runID, err := enqueueDocumentCommentRun(
		ctx, tx, documentCommentRunInput{
			TenantID: input.TenantID, RoomID: input.RoomID, DocumentID: input.DocumentID,
			CommentID: input.CommentID, CommentVersion: input.CommentVersion,
			AgentActorID: input.AgentActorID, AgentManagementID: agentManagementID,
			Notification:     projection.NotificationMarkdown,
			CommentsMarkdown: projection.CommentsMarkdown,
		},
	)
	if err != nil {
		return err
	}
	return enqueueNewCommentRunInputTx(ctx, tx, runID)
}

type notificationComment struct {
	ID, AuthorName, AuthorKind, Body string
	Segments                         []byte
	CreatedAt                        time.Time
}

type documentCommentProjection struct {
	NotificationMarkdown string
	CommentsMarkdown     string
}

func buildDocumentCommentNotification(ctx context.Context, tx pgx.Tx, input MentionInput) (documentCommentProjection, error) {
	var title, quotedText, contextBefore, contextAfter string
	if err := tx.QueryRow(ctx, `SELECT document.title,thread.anchor_quoted_text,
		thread.anchor_context_before,thread.anchor_context_after
		FROM room_document_comment_threads thread
		JOIN documents document
		  ON document.id=thread.document_id AND document.tenant_id=thread.tenant_id
		 AND document.status='active'
		WHERE thread.id=$1 AND thread.tenant_id=$2 AND thread.document_id=$3
		  AND thread.resolved_at IS NULL AND thread.anchor_status<>'orphaned'`, input.ThreadID, input.TenantID, input.DocumentID).Scan(
		&title, &quotedText, &contextBefore, &contextAfter,
	); err != nil {
		return documentCommentProjection{}, err
	}
	rows, err := tx.Query(ctx, `SELECT comment.id,author.display_name,author.kind,comment.body,
		comment.segments,comment.created_at
		FROM room_document_comments comment
		JOIN actors author
		  ON author.id=comment.author_actor_id AND author.tenant_id=comment.tenant_id
		WHERE comment.thread_id=$1 AND comment.deleted_at IS NULL
		ORDER BY comment.created_at,comment.id
		LIMIT 1000`, input.ThreadID)
	if err != nil {
		return documentCommentProjection{}, err
	}
	defer rows.Close()
	comments := make([]notificationComment, 0, 32)
	for rows.Next() {
		var comment notificationComment
		if err := rows.Scan(&comment.ID, &comment.AuthorName, &comment.AuthorKind, &comment.Body, &comment.Segments, &comment.CreatedAt); err != nil {
			return documentCommentProjection{}, err
		}
		comments = append(comments, comment)
	}
	if err := rows.Err(); err != nil {
		return documentCommentProjection{}, err
	}

	var message strings.Builder
	fmt.Fprintf(&message, "Document comment mention\n\nDocument: %s\nthread_id: %s\ntrigger_comment_id: %s\n\n", title, input.ThreadID, input.CommentID)
	message.WriteString(documentSelectionMarkdown(quotedText, contextBefore, contextAfter))
	fmt.Fprintf(&message, "\nRecent thread comments:\n- %d comments\n", len(comments))
	recentStart := len(comments) - 20
	if recentStart < 0 {
		recentStart = 0
	}
	for _, comment := range comments[recentStart:] {
		fmt.Fprintf(&message, "- %s: %s: %s\n", comment.ID, comment.AuthorName,
			truncateUTF8Bytes(notificationCommentText(comment), maxNotificationCommentTextBytes))
	}
	fmt.Fprintf(&message, "\nFull comments: ./%s/comments.md\n", input.DocumentID)
	fmt.Fprintf(&message, "Current document: ./%s/latest.md, read-only, as it was when this turn started; teamhub docs get %s reads it again after a change.", input.DocumentID, input.DocumentID)
	if message.Len() > maxDocumentNotificationMarkdownBytes {
		return documentCommentProjection{}, errors.New("Document Comment notification exceeds Runtime input limit")
	}
	commentsMarkdown, err := buildDocumentCommentsMarkdown(
		title, input.ThreadID, input.CommentID, quotedText, contextBefore, contextAfter, comments,
	)
	if err != nil {
		return documentCommentProjection{}, err
	}
	return documentCommentProjection{
		NotificationMarkdown: message.String(), CommentsMarkdown: commentsMarkdown,
	}, nil
}

func buildDocumentCommentsMarkdown(
	title, threadID, triggerCommentID, quotedText, contextBefore, contextAfter string,
	comments []notificationComment,
) (string, error) {
	var header strings.Builder
	header.WriteString("# Document comment thread\n\n")
	fmt.Fprintf(&header, "Document: %s\nthread_id: %s\ntrigger_comment_id: %s\n\n", title, threadID, triggerCommentID)
	header.WriteString(documentSelectionMarkdown(quotedText, contextBefore, contextAfter))
	fmt.Fprintf(&header, "\nVisible comments: %d\n\n", len(comments))

	lines := make([]string, len(comments))
	fullSize := header.Len()
	for index, comment := range comments {
		lines[index] = documentCommentMarkdownLine(comment)
		fullSize += len(lines[index])
	}
	if fullSize <= maxDocumentCommentsMarkdownBytes {
		return header.String() + strings.Join(lines, ""), nil
	}

	const truncationReserve = 128
	budget := maxDocumentCommentsMarkdownBytes - header.Len() - truncationReserve
	if budget <= 0 {
		return "", errors.New("Document Comment selection exceeds comments.md limit")
	}
	start := len(lines)
	used := 0
	for start > 0 {
		lineSize := len(lines[start-1])
		if used+lineSize > budget {
			break
		}
		start--
		used += lineSize
	}
	if start == len(lines) && len(lines) > 0 {
		start--
		lines[start] = truncateUTF8Bytes(lines[start], budget)
	}
	var result strings.Builder
	result.Grow(maxDocumentCommentsMarkdownBytes)
	result.WriteString(header.String())
	fmt.Fprintf(&result, "Showing the latest %d of %d visible comments; use get_document_comment_thread for the complete current thread.\n\n", len(lines)-start, len(lines))
	result.WriteString(strings.Join(lines[start:], ""))
	if result.Len() > maxDocumentCommentsMarkdownBytes {
		return "", errors.New("Document Comment comments.md projection exceeds limit")
	}
	return result.String(), nil
}

func documentCommentMarkdownLine(comment notificationComment) string {
	return fmt.Sprintf("- %s: %s (%s, %s): %s\n", comment.ID, comment.AuthorName,
		comment.AuthorKind, comment.CreatedAt.UTC().Format(time.RFC3339), notificationCommentText(comment))
}

func documentSelectionMarkdown(quotedText, contextBefore, contextAfter string) string {
	before := immediateContextBefore(contextBefore)
	after := immediateContextAfter(contextAfter)
	var result strings.Builder
	fmt.Fprintf(&result, "Selected text:\n\"%s\"\n",
		truncateUTF8Bytes(quotedText, maxNotificationSelectionBytes))
	if before == "" && after == "" {
		return result.String()
	}
	result.WriteString("\nContext:\n")
	if before != "" {
		result.WriteString(before)
		result.WriteByte('\n')
	}
	result.WriteString("[selection]\n")
	if after != "" {
		result.WriteString(after)
		result.WriteByte('\n')
	}
	return result.String()
}

func immediateContextBefore(value string) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) == 0 {
		return ""
	}
	searchFrom := len(runes) - 1
	if isContextSentenceBoundary(runes[searchFrom]) {
		searchFrom--
	}
	start := 0
	for index := searchFrom; index >= 0; index-- {
		if isContextSentenceBoundary(runes[index]) {
			start = index + 1
			break
		}
	}
	return boundedContextSentence(string(runes[start:]))
}

func immediateContextAfter(value string) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) == 0 {
		return ""
	}
	end := len(runes)
	for index, char := range runes {
		if isContextSentenceBoundary(char) {
			end = index + 1
			break
		}
	}
	return boundedContextSentence(string(runes[:end]))
}

func boundedContextSentence(value string) string {
	return truncateUTF8Bytes(
		strings.Join(strings.Fields(strings.TrimSpace(value)), " "),
		maxNotificationContextBytes,
	)
}

func isContextSentenceBoundary(value rune) bool {
	switch value {
	case '\n', '\r', '.', '!', '?', '\u3002', '\uff01', '\uff1f':
		return true
	default:
		return false
	}
}

func notificationCommentText(comment notificationComment) string {
	var segments []struct {
		Type, Content string
	}
	if json.Unmarshal(comment.Segments, &segments) == nil {
		var text strings.Builder
		for _, segment := range segments {
			text.WriteString(segment.Content)
		}
		if value := strings.TrimSpace(text.String()); value != "" {
			return strings.Join(strings.Fields(value), " ")
		}
	}
	return strings.Join(strings.Fields(comment.Body), " ")
}

func truncateUTF8Bytes(value string, maximum int) string {
	if maximum < 1 || len(value) <= maximum {
		return value
	}
	const suffix = "... [truncated]"
	end := maximum - len(suffix)
	if end < 0 {
		return ""
	}
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return strings.TrimSpace(value[:end]) + suffix
}

func newInputID(prefix string) string { return prefix + uuid.NewString() }

func AcquireGenerationLock(ctx context.Context, queries *store.Queries, documentID string) error {
	return queries.AcquireAdvisoryTransactionLock(ctx, "document-revision-input-generation|"+documentID)
}
