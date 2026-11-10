package voicelive

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// Document tools: the live voice creates, renames and edits the Documents
// the call's Agent may edit, as that Agent, and reads and writes their
// comments as the user, the way the user comments in the side panel.
const (
	ToolCreateDocument      = "create_document"
	ToolRenameDocument      = "rename_document"
	ToolEditDocument        = "edit_document"
	ToolReplaceDocumentText = "replace_document_text"
	ToolListComments        = "list_comments"
	ToolAddComment          = "add_comment"
	ToolReplyComment        = "reply_comment"
	ToolResolveComment      = "resolve_comment"
)

// MaxRewriteRunes bounds a document the live model rewrites whole.
const MaxRewriteRunes = 8000

// MaxCreateDocumentRunes bounds the body of a document the live model creates.
const MaxCreateDocumentRunes = 20000

const documentTarget = "document_id comes from create_document, read_document, search_documents, open_email_canvas or task results. "

// DocumentTools are the document and comment tools.
var DocumentTools = []Tool{
	{
		Name: ToolCreateDocument,
		Description: "Create a new document in this room and open it beside the chat, such as meeting notes, a plan, a checklist or a draft the user asks for (“make a doc”, “write this up”). " +
			"title is one line; content is the whole body in Markdown, written only from what the user said and this conversation; never invent facts, names or numbers. An empty content makes an empty document. " +
			"It returns document_id and revision_id. Then say in one short sentence what you wrote and that it is open beside the chat. Change it later with edit_document, replace_document_text or rename_document. " +
			"An email is open_email_canvas; research and long reports are start_task.",
		Parameters: objectSchema([]string{"title"}, map[string]any{
			"title":   stringProperty("The document title, one line"),
			"content": stringProperty("The whole body in Markdown"),
		}),
	},
	{
		Name: ToolRenameDocument,
		Description: "Rename a document or canvas in this app: its title, which is the file name shown in the side panel and in chat. " + documentTarget +
			"Then say in one short sentence what it is called now. document_not_editable means the Agent may not edit it: say so plainly.",
		Parameters: objectSchema([]string{"document_id", "title"}, map[string]any{
			"document_id": stringProperty("The document to rename"),
			"title":       stringProperty("The new title, one line"),
		}),
	},
	{
		Name: ToolReplaceDocumentText,
		Description: "Replace one line of text in a document or canvas in this app, such as a date, a name or a sentence; it changes in the side panel at once. " + documentTarget +
			"find is that text copied exactly from the document (read it first with read_document), long enough to occur once; replace_with is the new text. " +
			"text_not_found or ambiguous_text: read the document and use longer exact text. Changes over several lines, or removing text, are edit_document with rewrite. " +
			"For a Gmail canvas use edit_email_canvas instead. When it is changed, say in one short sentence what you changed. document_not_editable means the Agent may not edit it.",
		Parameters: objectSchema([]string{"document_id", "find", "replace_with"}, map[string]any{
			"document_id":  stringProperty("The document to change"),
			"find":         stringProperty("The exact one line of text to replace"),
			"replace_with": stringProperty("The new text for it, one line"),
		}),
	},
	{
		Name: ToolEditDocument,
		Description: "Add to a document or canvas in this app, or rewrite all of it, as the user asks; it changes in the side panel at once. " + documentTarget +
			"command append adds content (Markdown) at the end. command rewrite replaces the whole document with content: all of it in Markdown, keeping what the user did not ask to change. " +
			"A rewrite needs the revision_id of the text you rewrote: call it without revision_id first, or after document_changed, to get the latest text and revision_id, redo the change on that text and call again. " +
			"To change one line, use replace_document_text instead. document_has_media (images or files) or document_locked: use append or replace_document_text, or start_task naming the document_id. " +
			"For a Gmail canvas use edit_email_canvas instead. When it is changed, say in one short sentence what you changed. document_not_editable means the Agent may not edit it.",
		Parameters: objectSchema([]string{"document_id", "command", "content"}, map[string]any{
			"document_id": stringProperty("The document to change"),
			"command":     map[string]any{"type": "string", "enum": []string{"append", "rewrite"}, "description": "append or rewrite"},
			"content":     stringProperty("The Markdown to append, or the whole rewritten document"),
			"revision_id": stringProperty("rewrite: the revision_id of the text you rewrote"),
		}),
	},
	{
		Name: ToolListComments,
		Description: "Read the comment threads on a document or canvas, open ones first: each has thread_id, the quoted text it is on, whether it is resolved, and its comments (author and text). " + documentTarget +
			"Use it when the user asks what people said about a document. Mention the few that matter.",
		Parameters: objectSchema([]string{"document_id"}, map[string]any{
			"document_id": stringProperty("The document whose comments to read"),
		}),
	},
	{
		Name: ToolAddComment,
		Description: "Comment on a passage of a document or canvas as the user, under their name, as they would in the side panel. " + documentTarget +
			"quote is the exact text the comment is on, copied from the document and long enough to occur once; text is only what the user wants to say. " +
			"First call without confirmed: it returns needs_confirmation; say what will be commented where and ask. Only after the user says yes in their next turn, call again with confirmed=true. " +
			"quote_not_found or ambiguous_quote: read the document and pick exact text that occurs once.",
		Parameters: objectSchema([]string{"document_id", "quote", "text", "confirmed"}, map[string]any{
			"document_id": stringProperty("The document to comment on"),
			"quote":       stringProperty("The exact text the comment is on"),
			"text":        stringProperty("The comment"),
			"confirmed":   map[string]any{"type": "boolean", "description": "Whether the user said yes to posting it, in their own next turn"},
		}),
	},
	{
		Name: ToolReplyComment,
		Description: "Reply in a comment thread as the user, under their name. thread_id comes from list_comments; text is only what the user wants to say. " +
			"First call without confirmed: it returns needs_confirmation; say the reply and ask. Only after the user says yes in their next turn, call again with confirmed=true.",
		Parameters: objectSchema([]string{"thread_id", "text", "confirmed"}, map[string]any{
			"thread_id": stringProperty("The thread, from list_comments"),
			"text":      stringProperty("The reply"),
			"confirmed": map[string]any{"type": "boolean", "description": "Whether the user said yes to posting it, in their own next turn"},
		}),
	},
	{
		Name:        ToolResolveComment,
		Description: "Mark a comment thread resolved, or open it again with reopen=true, as the user. thread_id comes from list_comments. Then say so in a few words.",
		Parameters: objectSchema([]string{"thread_id"}, map[string]any{
			"thread_id": stringProperty("The thread, from list_comments"),
			"reopen":    map[string]any{"type": "boolean", "description": "Open a resolved thread again instead"},
		}),
	},
}

// DocumentArguments holds the arguments of every document tool.
type DocumentArguments struct {
	DocumentID  string    `json:"document_id"`
	Title       string    `json:"title"`
	Command     string    `json:"command"`
	Find        string    `json:"find"`
	ReplaceWith string    `json:"replace_with"`
	Content     string    `json:"content"`
	RevisionID  string    `json:"revision_id"`
	Quote       string    `json:"quote"`
	Text        string    `json:"text"`
	ThreadID    string    `json:"thread_id"`
	Reopen      LooseBool `json:"reopen"`
	Confirmed   LooseBool `json:"confirmed"`
}

// DocumentEdit is the native edit operation for a change the live model
// asked for; problem names what it must fix instead.
func DocumentEdit(args DocumentArguments) (edit map[string]string, problem string) {
	edit = map[string]string{"kind": "edit_document", "parser_version": "markdown-v1"}
	switch args.Command {
	case "append":
		if strings.TrimSpace(args.Content) == "" {
			return nil, "content_required"
		}
		edit["command"], edit["content"] = "append", args.Content
	case "replace_text":
		if strings.TrimSpace(args.ReplaceWith) == "" {
			// A missing replacement would delete the text; deleting is a rewrite.
			return nil, "replace_with_required"
		}
		if args.Find == "" || strings.ContainsAny(args.Find, "\r\n") || strings.ContainsAny(args.ReplaceWith, "\r\n") {
			// One line each: longer changes are a rewrite.
			return nil, "replace_is_one_line"
		}
		edit["command"], edit["pattern"], edit["content"] = "str_replace", args.Find, args.ReplaceWith
	default:
		return nil, "invalid_command"
	}
	return edit, ""
}

// DocumentTitle is the title a rename sets; false when it is not one line.
func DocumentTitle(raw string) (string, bool) {
	title := strings.Join(strings.Fields(raw), " ")
	return title, title != "" && utf8.RuneCountInString(title) <= 255
}

// DocumentBlock is one block of a blocks export with its own text.
type DocumentBlock struct {
	ID, Text string
}

type exportBlock struct {
	ID       string          `json:"id"`
	Content  json.RawMessage `json:"content"`
	Children []exportBlock   `json:"children"`
}

// DocumentBlocks reads a blocks export in document order, each block with
// the text of its own inline content, as comment anchors match text.
func DocumentBlocks(export []byte) ([]DocumentBlock, bool) {
	var document struct {
		Blocks []exportBlock `json:"blocks"`
	}
	if json.Unmarshal(export, &document) != nil {
		return nil, false
	}
	blocks := []DocumentBlock{}
	var visit func([]exportBlock)
	visit = func(list []exportBlock) {
		for _, block := range list {
			blocks = append(blocks, DocumentBlock{ID: block.ID, Text: inlineText(block.Content)})
			visit(block.Children)
		}
	}
	visit(document.Blocks)
	return blocks, true
}

func inlineText(raw json.RawMessage) string {
	var items []struct {
		Text    string          `json:"text"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &items) != nil {
		return ""
	}
	var text strings.Builder
	for _, item := range items {
		text.WriteString(item.Text)
		if len(item.Content) > 0 {
			text.WriteString(inlineText(item.Content))
		}
	}
	return text.String()
}

// CommentAnchor finds the one block a quote is in; problem is
// quote_not_found or ambiguous_quote otherwise. A quote that occurs once in
// the document needs no context to be attached.
func CommentAnchor(blocks []DocumentBlock, quote string) (blockID, problem string) {
	if strings.TrimSpace(quote) == "" || utf8.RuneCountInString(quote) > 10000 {
		return "", "quote_not_found"
	}
	found := 0
	for _, block := range blocks {
		if count := strings.Count(block.Text, quote); count > 0 {
			found += count
			blockID = block.ID
		}
	}
	switch {
	case found == 0:
		return "", "quote_not_found"
	case found > 1:
		return "", "ambiguous_quote"
	}
	return blockID, ""
}
