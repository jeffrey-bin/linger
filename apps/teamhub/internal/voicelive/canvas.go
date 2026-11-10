package voicelive

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Gmail canvas tools: the live voice writes and changes the canvas the
// Agent's canvas Skill opens, as that Agent. The user reads and edits it in
// the side panel; a Task of the same Agent saves or sends it.
const (
	ToolOpenEmailCanvas = "open_email_canvas"
	ToolEditEmailCanvas = "edit_email_canvas"
	ToolAttachEmailFile = "attach_email_file"
)

// MaxEmailBodyRunes bounds the email body the live model writes.
const MaxEmailBodyRunes = 20000

// canvasTitleRunes bounds the canvas title, taken from the subject.
const canvasTitleRunes = 80

// emailCanvasDelivery says how a canvas is saved or sent, for both tools.
const emailCanvasDelivery = "To save it in the user's Gmail as a draft use save_email_draft, and to send it send_email_canvas, when those tools are offered; otherwise call start_task with surface apps and a goal that names its document_id as a Gmail canvas and says to save it as a draft or to send it, with irreversible set for a send. "

// EmailCanvasTool describes the tool that opens a new canvas.
var EmailCanvasTool = Tool{
	Name: ToolOpenEmailCanvas,
	Description: "Write a new email for the user on a canvas in this room. It opens in the side panel at once, where the user reads and edits it themselves, like the email drafts the Agent writes. " +
		"Use it whenever the user wants a new email written or drafted, instead of start_task; answering an email someone sent is start_task with surface apps. " +
		"to and cc hold only email addresses the user gave, separated by commas; leave them empty rather than guess, and ask for them when it is time to send. " +
		"subject is one line; body is the whole email in the language the user wants it in, plain text with a blank line between paragraphs, written only from what the user said: never invent facts, times or names. " +
		"It returns document_id and revision_id. Then tell the user in one or two short sentences what you wrote (who it is to and the main points) and that it is open for them to look at and change; read it out in full only when they ask. " +
		"Change it later with edit_email_canvas, and attach a file to it with attach_email_file. " + emailCanvasDelivery +
		"invalid_recipients means an address is not an email address: ask the user for it.",
	Parameters: objectSchema([]string{"subject", "body"}, map[string]any{
		"to":      stringProperty("Optional recipient email addresses, separated by commas"),
		"cc":      stringProperty("Optional carbon-copy email addresses, separated by commas"),
		"subject": stringProperty("The subject, one line"),
		"body":    stringProperty("The whole email body"),
	}),
}

// EditEmailCanvasTool describes the tool that changes a canvas.
var EditEmailCanvasTool = Tool{
	Name: ToolEditEmailCanvas,
	Description: "Change a Gmail canvas in this room as the user asks: its recipients, subject or body. It changes in the side panel at once. " +
		"Give only what changes: to, cc or subject replace that line, and the canvas title follows the subject, so never rename an email canvas yourself; body replaces the whole body text, so write all of it, keeping what the user did not ask to change. Attached files are not part of the body: they stay attached, listed as attachments, wherever they sat. " +
		"revision_id is the one the last open_email_canvas or edit_email_canvas result gave for this document_id. " +
		"canvas_changed means the canvas is not as you last saw it (the user may have edited it): its result has the latest text and revision_id; redo the change on that text, keeping the user's own edits, and call again with that revision_id. " +
		"When it is changed, tell the user in one short sentence what you changed. " + emailCanvasDelivery +
		"canvas_has_media means images sit among the text, which a body rewrite would lose: recipients and subject still change here; change the body with start_task instead, naming the document_id. canvas_locked: change it with start_task instead, naming the document_id. invalid_recipients means an address is not an email address: ask the user for it.",
	Parameters: objectSchema([]string{"document_id", "revision_id"}, map[string]any{
		"document_id": stringProperty("The canvas, from open_email_canvas"),
		"revision_id": stringProperty("The revision_id the last result gave for this canvas"),
		"to":          stringProperty("Optional new recipient email addresses, separated by commas"),
		"cc":          stringProperty("Optional new carbon-copy email addresses, separated by commas"),
		"subject":     stringProperty("Optional new subject, one line"),
		"body":        stringProperty("Optional new whole email body"),
	}),
}

// AttachEmailFileTool describes the tool that attaches a file to a canvas.
var AttachEmailFileTool = Tool{
	Name: ToolAttachEmailFile,
	Description: "Attach a file to a Gmail canvas in this room, so the email goes out with it: a document or file in this app (one shared in a room or in the Library, such as a deck a task delivered; find its document_id with search_documents) or a task's output file (task_id with file, a path as task_files lists it). It is added at the end of the canvas at once; never call start_task for this. " +
		"Give exactly one of file_document_id and task_id. It returns the canvas's attachments and revision_id: tell the user in one short sentence what is attached. " +
		"file_not_supported means the email cannot carry that kind of file (it takes PDF, Office, image, text and ZIP files); file_too_large means it is over 15 MB.",
	Parameters: objectSchema([]string{"document_id"}, map[string]any{
		"document_id":      stringProperty("The canvas, from open_email_canvas"),
		"file_document_id": stringProperty("The document or file in this app to attach, from search_documents"),
		"task_id":          stringProperty("Or the task whose output file to attach, such as t1; needs file"),
		"file":             stringProperty("With task_id: the output file's path, such as report.pptx"),
	}),
}

// AttachEmailFileArguments names the canvas and the file to attach.
type AttachEmailFileArguments struct {
	DocumentID     string `json:"document_id"`
	FileDocumentID string `json:"file_document_id"`
	TaskID         string `json:"task_id"`
	File           string `json:"file"`
}

// EmailCanvasArguments holds the email the live model wrote.
type EmailCanvasArguments struct {
	To      string `json:"to"`
	Cc      string `json:"cc"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
}

// EditEmailCanvasArguments holds a change to a canvas: nil keeps a value.
type EditEmailCanvasArguments struct {
	DocumentID string  `json:"document_id"`
	RevisionID string  `json:"revision_id"`
	To         *string `json:"to"`
	Cc         *string `json:"cc"`
	Subject    *string `json:"subject"`
	Body       *string `json:"body"`
}

// Canvas is a canvas Document's title and Markdown.
type Canvas struct {
	Title, Markdown string
}

var emailAddress = regexp.MustCompile(`^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$`)

// EmailCanvas is the email as a Gmail canvas, in the shape the canvas Skill
// and Web read: a header code block, then the body. problem names what the
// live model must fix, such as a recipient that is not an email address.
func EmailCanvas(args EmailCanvasArguments) (canvas Canvas, problem string) {
	subject := strings.Join(strings.Fields(args.Subject), " ")
	to, toOK := recipients(args.To)
	cc, ccOK := recipients(args.Cc)
	if problem := emailProblem(subject, args.Body, toOK && ccOK); problem != "" {
		return Canvas{}, problem
	}
	return Canvas{
		Title: EmailCanvasTitle(subject),
		Markdown: emailCanvasMarkdown(map[string]string{
			"to": to, "cc": cc, "subject": subject, "status": "editing",
		}, args.Body),
	}, ""
}

// EmailCanvasTitle is the canvas title a subject gives: the canvas is named
// after its email.
func EmailCanvasTitle(subject string) string {
	title, _ := Truncate(oneLine(subject), canvasTitleRunes)
	return title
}

// EditedEmailCanvas is the canvas Markdown after the change, from the
// current header fields and body; every field the change leaves out stays.
func EditedEmailCanvas(fields map[string]string, body string, args EditEmailCanvasArguments) (markdown, header, problem string) {
	next := map[string]string{}
	for name, value := range fields {
		next[name] = value
	}
	recipientsOK := true
	for name, value := range map[string]*string{"to": args.To, "cc": args.Cc} {
		if value == nil {
			continue
		}
		joined, ok := recipients(*value)
		recipientsOK = recipientsOK && ok
		next[name] = joined
	}
	if args.Subject != nil {
		next["subject"] = strings.Join(strings.Fields(*args.Subject), " ")
	}
	if args.Body != nil {
		body = *args.Body
	}
	if problem := emailProblem(next["subject"], body, recipientsOK); problem != "" {
		return "", "", problem
	}
	return emailCanvasMarkdown(next, body), EmailCanvasHeader(next), ""
}

func emailProblem(subject, body string, recipientsOK bool) string {
	body = strings.TrimSpace(body)
	switch {
	case !recipientsOK:
		return "invalid_recipients"
	case subject == "" || body == "" || utf8.RuneCountInString(body) > MaxEmailBodyRunes:
		return "invalid_email"
	}
	return ""
}

// canvasFieldOrder is the header order the canvas Skill writes; other
// fields a canvas carries follow in name order.
var canvasFieldOrder = []string{"to", "cc", "subject", "status", "link", "external_id"}

func emailCanvasMarkdown(fields map[string]string, body string) string {
	return EmailCanvasHeader(fields) + "\n" + strings.TrimSpace(body) + "\n"
}

// EmailCanvasHeader is the canvas header block alone, for changing its lines.
func EmailCanvasHeader(fields map[string]string) string {
	names := append([]string{}, canvasFieldOrder...)
	extra := []string{}
	for name := range fields {
		known := false
		for _, ordered := range canvasFieldOrder {
			known = known || name == ordered
		}
		if !known {
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	var header strings.Builder
	header.WriteString("```\ncanvas: gmail\n")
	for _, name := range append(names, extra...) {
		// Every line is written, empty or not, so each can be filled in place.
		header.WriteString(strings.TrimRight(name+": "+oneLine(fields[name]), " ") + "\n")
	}
	return header.String() + "```\n"
}

func oneLine(value string) string { return strings.Join(strings.Fields(value), " ") }

// IsEmailAddress reports whether value is one email address.
func IsEmailAddress(value string) bool { return emailAddress.MatchString(value) }

// recipients joins the addresses with commas, the only separator a Gmail
// canvas accepts; false when one is not an email address.
// recipientSeparator splits a spoken list of addresses: spacing and any
// punctuation, in any script, that cannot be part of an address.
func recipientSeparator(r rune) bool {
	return unicode.IsSpace(r) || unicode.IsPunct(r) && !strings.ContainsRune("@._-+'%!#&*/?", r)
}

func recipients(raw string) (string, bool) {
	addresses := []string{}
	for _, address := range strings.FieldsFunc(raw, recipientSeparator) {
		if !emailAddress.MatchString(address) {
			return "", false
		}
		addresses = append(addresses, address)
	}
	return strings.Join(addresses, ", "), true
}
