package agentconnectedapps

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// draftReadTool reads the draft a send-draft call sends. The call names only
// the draft, so TeamHub reads it to show what will be sent.
var draftReadTool = map[string]string{
	"GMAIL_SEND_DRAFT":   "GMAIL_GET_DRAFT",
	"OUTLOOK_SEND_DRAFT": "OUTLOOK_GET_MESSAGE",
}

const (
	maxCardInput = 8000
	maxCardBody  = 20000
	maxCardValue = 4000
)

// describeConfirmation builds the card from the stored call alone. Titles and
// fields come from the call's own arguments, never from text the Agent wrote
// about the call.
func describeConfirmation(connection externalsource.AgentToolConnection, action confirmationAction) typedcard.ConnectorWriteView {
	account := connection.IdentityLabel
	if account == "" {
		account = connection.DisplayName
	}
	card := typedcard.ConnectorWriteView{Kind: "change", App: connection.AppKey, Account: account}
	card.Tool, card.Input = action.ToolSlug, jsonText(action.Arguments, maxCardInput)
	// A tool without its own layout below shows its exact arguments.
	card.Title = "Run " + action.ToolSlug
	args := action.Arguments
	switch action.ToolSlug {
	case "GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD":
		to := append(strs(args, "recipient_email"), strs(args, "extra_recipients")...)
		message := &typedcard.ConnectorWriteMessage{
			To: to, Cc: strs(args, "cc"), Bcc: strs(args, "bcc"), Subject: str(args, "subject"),
			Body: truncate(firstString(args, "body", "message_body"), maxCardBody), Format: htmlOrText(args["is_html"]),
			Attachments: fileNames(args["attachment"]),
		}
		card.Title = mailTitle("Send an email", to)
		if action.ToolSlug == "GMAIL_REPLY_TO_THREAD" {
			card.Title = mailTitle("Reply to an email", to)
			message.Destination = "Gmail thread " + str(args, "thread_id")
		}
		card.Kind, card.Message = "message", message
	case "OUTLOOK_SEND_EMAIL":
		to := strs(args, "to")
		card.Kind, card.Title = "message", mailTitle("Send an email", to)
		card.Message = &typedcard.ConnectorWriteMessage{
			To: to, Cc: strs(args, "cc_emails"), Bcc: strs(args, "bcc_emails"), Subject: str(args, "subject"),
			Body: truncate(str(args, "body"), maxCardBody), Format: htmlOrText(args["is_html"]),
		}
	case "GMAIL_SEND_DRAFT", "OUTLOOK_SEND_DRAFT":
		// The draft's content is read and filled in by the caller.
		card.Kind, card.Title = "message", "Send an email"
	case "SLACK_SEND_MESSAGE":
		card.Kind, card.Title = "message", "Send a Slack message"
		card.Message = &typedcard.ConnectorWriteMessage{
			Destination: slackDestination(str(args, "channel"), str(args, "thread_ts")),
			Body:        truncate(str(args, "markdown_text"), maxCardBody), Format: "markdown",
		}
	case "SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK":
		card.Kind, card.Title = "message", "Share files in Slack"
		card.Message = &typedcard.ConnectorWriteMessage{
			Destination: slackDestination(strings.Join(strs(args, "channels"), ", "), str(args, "thread_ts")),
			Body:        truncate(str(args, "initial_comment"), maxCardBody), Format: "mrkdwn", Attachments: fileNames(args["file"]),
		}
	case "GITHUB_CREATE_AN_ISSUE_COMMENT":
		target := str(args, "owner") + "/" + str(args, "repo") + "#" + str(args, "issue_number")
		card.Kind, card.Title = "message", "Comment on "+target
		card.Message = &typedcard.ConnectorWriteMessage{
			Destination: "GitHub " + target, Body: truncate(str(args, "body"), maxCardBody), Format: "markdown",
		}
	case "GITHUB_CREATE_AN_ISSUE":
		repository := str(args, "owner") + "/" + str(args, "repo")
		card.Kind, card.Title = "message", "Create an issue in "+repository
		card.Message = &typedcard.ConnectorWriteMessage{
			Destination: "GitHub " + repository, Subject: str(args, "title"),
			Body: truncate(str(args, "body"), maxCardBody), Format: "markdown",
		}
	case "NOTION_CREATE_NOTION_PAGE":
		card.Title = "Create Notion page: " + str(args, "title")
		card.Fields = fields("Parent", str(args, "parent_id"), "Title", str(args, "title"), "Content", str(args, "markdown"))
	case "NOTION_ADD_MULTIPLE_PAGE_CONTENT":
		card.Title = "Append to a Notion page"
		card.Fields = fields("Page", str(args, "parent_block_id"), "Content", jsonValue(args["content_blocks"]))
	case "NOTION_UPDATE_PAGE_MARKDOWN":
		card.Title = "Edit a Notion page"
		card.Fields = fields("Page", str(args, "page_id"), "Changes", jsonValue(args["update_content"]))
	}
	card.Title = truncate(card.Title, 200)
	return card
}

// readDraft reads the draft a send-draft call sends, in the shape the card shows.
func (s *Service) readDraft(ctx context.Context, connection externalsource.AgentToolConnection, action confirmationAction) (*typedcard.ConnectorWriteMessage, error) {
	read := draftReadTool[action.ToolSlug]
	if action.ToolSlug == "GMAIL_SEND_DRAFT" {
		data, err := s.readTool(ctx, connection, read, action.ToolVersion, map[string]any{"draft_id": str(action.Arguments, "draft_id"), "format": "full"})
		if err != nil {
			return nil, err
		}
		message, ok := data["message"].(map[string]any)
		if !ok {
			return nil, errDraftUnreadable
		}
		return gmailDraftMessage(message)
	}
	id := str(action.Arguments, "message_id")
	data, err := s.readTool(ctx, connection, read, action.ToolVersion, map[string]any{"message_id": id})
	if err != nil {
		return nil, err
	}
	message := outlookDraftMessage(data)
	attachments, err := s.readTool(ctx, connection, "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS", action.ToolVersion,
		map[string]any{"message_id": id, "response_detail": "minimal", "top": 1000})
	if err != nil {
		return nil, err
	}
	if items, ok := attachments["value"].([]any); ok {
		message.Attachments = fileNames(items)
	}
	return message, nil
}

func gmailDraftMessage(message map[string]any) (*typedcard.ConnectorWriteMessage, error) {
	payload, _ := message["payload"].(map[string]any)
	header := func(name string) string {
		headers, _ := payload["headers"].([]any)
		for _, item := range headers {
			if entry, ok := item.(map[string]any); ok && strings.EqualFold(str(entry, "name"), name) {
				return str(entry, "value")
			}
		}
		return ""
	}
	result := &typedcard.ConnectorWriteMessage{
		To: addressList(header("to")), Cc: addressList(header("cc")), Bcc: addressList(header("bcc")),
		Subject: header("subject"), Format: "text",
	}
	var text, html string
	var visit func(part map[string]any) error
	visit = func(part map[string]any) error {
		body, _ := part["body"].(map[string]any)
		mime := str(part, "mimeType")
		if name := str(part, "filename"); name != "" {
			result.Attachments = append(result.Attachments, name)
		} else if data := str(body, "data"); data != "" && (mime == "text/plain" || mime == "text/html") {
			decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(data, "="))
			if err != nil || !utf8.Valid(decoded) {
				return errDraftUnreadable
			}
			if mime == "text/html" {
				html = string(decoded)
			} else {
				text = string(decoded)
			}
		}
		parts, _ := part["parts"].([]any)
		for _, item := range parts {
			if child, ok := item.(map[string]any); ok {
				if err := visit(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if payload != nil {
		if err := visit(payload); err != nil {
			return nil, err
		}
	}
	switch {
	case html != "":
		result.Body, result.Format = html, "html"
	case text != "":
		result.Body = text
	default:
		result.Body = str(message, "messageText")
	}
	result.Body = truncate(result.Body, maxCardBody)
	return result, nil
}

func outlookDraftMessage(data map[string]any) *typedcard.ConnectorWriteMessage {
	recipients := func(key string) []string {
		items, _ := data[key].([]any)
		addresses := make([]string, 0, len(items))
		for _, item := range items {
			entry, _ := item.(map[string]any)
			address, _ := entry["emailAddress"].(map[string]any)
			if value := str(address, "address"); value != "" {
				if name := str(address, "name"); name != "" && name != value {
					value = name + " <" + value + ">"
				}
				addresses = append(addresses, value)
			}
		}
		return addresses
	}
	body, _ := data["body"].(map[string]any)
	return &typedcard.ConnectorWriteMessage{
		To: recipients("toRecipients"), Cc: recipients("ccRecipients"), Bcc: recipients("bccRecipients"),
		Subject: str(data, "subject"), Body: truncate(str(body, "content"), maxCardBody),
		Format: htmlOrText(strings.EqualFold(str(body, "contentType"), "html")),
	}
}

func mailTitle(verb string, to []string) string {
	switch len(to) {
	case 0:
		return verb
	case 1:
		return verb + " to " + to[0]
	default:
		return fmt.Sprintf("%s to %s and %d others", verb, to[0], len(to)-1)
	}
}

func slackDestination(channel, thread string) string {
	destination := "Slack " + channel
	if thread != "" {
		destination += ", thread " + thread
	}
	return destination
}

// str reads an argument as display text; numbers keep their JSON form.
func str(values map[string]any, key string) string {
	switch value := values[key].(type) {
	case string:
		return value
	case json.Number:
		return value.String()
	case float64:
		return fmt.Sprint(int64(value))
	case nil:
		return ""
	default:
		return fmt.Sprint(value)
	}
}

func firstString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := str(values, key); value != "" {
			return value
		}
	}
	return ""
}

func strs(values map[string]any, key string) []string {
	switch value := values[key].(type) {
	case string:
		if value == "" {
			return nil
		}
		return []string{value}
	case []any:
		items := make([]string, 0, len(value))
		for _, item := range value {
			if text, ok := item.(string); ok && text != "" {
				items = append(items, text)
			}
		}
		return items
	case []string:
		return value
	default:
		return nil
	}
}

func addressList(header string) []string {
	var addresses []string
	for _, item := range strings.Split(header, ",") {
		if item = strings.TrimSpace(item); item != "" {
			addresses = append(addresses, item)
		}
	}
	return addresses
}

func fileNames(value any) []string {
	var items []any
	switch typed := value.(type) {
	case []any:
		items = typed
	case map[string]any:
		items = []any{typed}
	}
	names := make([]string, 0, len(items))
	for _, item := range items {
		if entry, ok := item.(map[string]any); ok {
			if name := str(entry, "name"); name != "" {
				names = append(names, name)
			}
		}
	}
	return names
}

func htmlOrText(html any) string {
	if html == true {
		return "html"
	}
	return "text"
}

// fields pairs labels with values and drops empty values.
func fields(pairs ...string) []typedcard.ConnectorWriteField {
	var result []typedcard.ConnectorWriteField
	for index := 0; index+1 < len(pairs); index += 2 {
		if strings.TrimSpace(pairs[index+1]) != "" {
			result = append(result, typedcard.ConnectorWriteField{Label: pairs[index], Value: truncate(pairs[index+1], maxCardValue)})
		}
	}
	return result
}

func jsonValue(value any) string {
	if value == nil {
		return ""
	}
	return jsonText(value, maxCardValue)
}

func jsonText(value any, limit int) string {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return ""
	}
	return truncate(string(encoded), limit)
}

func truncate(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit]) + "…"
}
