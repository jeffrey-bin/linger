package composio

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/html"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/emailevidence"
)

var ErrGmailHistoryExpired = errors.New("Gmail history checkpoint expired")

type GmailIdentity struct {
	EmailAddress string
	HistoryID    string
}

func (c *Client) IdentifyGmail(ctx context.Context, connectedAccountID string) (GmailIdentity, error) {
	var profile struct {
		EmailAddress string `json:"emailAddress"`
		HistoryID    string `json:"historyId"`
	}
	if err := c.proxy(ctx, proxyRequest{
		ConnectedAccountID: connectedAccountID,
		Endpoint:           "/gmail/v1/users/me/profile",
		Method:             http.MethodGet,
	}, &profile, "identify Gmail account"); err != nil {
		return GmailIdentity{}, err
	}
	profile.EmailAddress = strings.ToLower(strings.TrimSpace(profile.EmailAddress))
	if profile.EmailAddress == "" || profile.HistoryID == "" {
		return GmailIdentity{}, errors.New("Gmail profile returned an invalid response")
	}
	return GmailIdentity{EmailAddress: profile.EmailAddress, HistoryID: profile.HistoryID}, nil
}

type gmailThreadPayload struct {
	ID       string         `json:"id"`
	Messages []gmailMessage `json:"messages"`
}

type gmailMessage struct {
	ID           string    `json:"id"`
	ThreadID     string    `json:"threadId"`
	InternalDate string    `json:"internalDate"`
	LabelIDs     []string  `json:"labelIds"`
	Payload      gmailPart `json:"payload"`
}

type gmailPart struct {
	MimeType string `json:"mimeType"`
	Filename string `json:"filename"`
	Headers  []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"headers"`
	Body struct {
		Data         string `json:"data"`
		AttachmentID string `json:"attachmentId"`
	} `json:"body"`
	Parts []gmailPart `json:"parts"`
}

func renderGmailInsightEvidence(thread gmailThreadPayload, maxBodyBytes, maxThreadBytes int) ([]byte, error) {
	if thread.ID == "" {
		return nil, errors.New("Gmail thread response is missing its ID")
	}
	inputs := make([]emailevidence.MessageInput, 0, len(thread.Messages))
	for _, message := range thread.Messages {
		body, err := authoredBody(message.Payload, maxBodyBytes)
		if err != nil {
			return nil, err
		}
		if body == "" {
			continue
		}
		senderLocal := ""
		if address, parseErr := mail.ParseAddress(header(message.Payload, "From")); parseErr == nil {
			senderLocal = strings.ToLower(strings.SplitN(address.Address, "@", 2)[0])
		}
		inputs = append(inputs, emailevidence.MessageInput{
			ThreadID: thread.ID, MessageID: message.ID, Timestamp: messageTimestamp(message),
			Direction: emailevidence.Direction(gmailMessageDirectionValue(message)),
			Signals:   gmailMessageSignals(message), SenderLocal: senderLocal, Body: body,
		})
	}
	raw, err := json.Marshal(inputs)
	if err != nil {
		return nil, err
	}
	if len(raw) > maxThreadBytes {
		return emailevidence.BoundMessageInputsJSON(raw, maxThreadBytes)
	}
	return raw, nil
}

func gmailMessageExcluded(message gmailMessage) bool {
	for _, label := range message.LabelIDs {
		if strings.EqualFold(label, "SPAM") || strings.EqualFold(label, "TRASH") {
			return true
		}
	}
	return false
}

func gmailMessageDirectionValue(message gmailMessage) string {
	draft := false
	for _, label := range message.LabelIDs {
		if strings.EqualFold(label, "SENT") {
			return "outbound"
		}
		if strings.EqualFold(label, "DRAFT") {
			draft = true
		}
	}
	if draft {
		return "draft"
	}
	return "inbound"
}

// gmailMessageSignals reads only structural header and label facts; sender
// names and body wording never mark mail as automated.
func gmailMessageSignals(message gmailMessage) emailevidence.Signals {
	signals := emailevidence.Signals{
		ListID:          header(message.Payload, "List-Id") != "",
		ListUnsubscribe: header(message.Payload, "List-Unsubscribe") != "",
	}
	for _, label := range message.LabelIDs {
		if strings.HasPrefix(strings.ToUpper(label), "CATEGORY_") {
			signals.Category = label
			break
		}
	}
	autoSubmitted := strings.ToLower(strings.TrimSpace(header(message.Payload, "Auto-Submitted")))
	signals.AutoSubmitted = autoSubmitted != "" && autoSubmitted != "no"
	switch strings.ToLower(strings.TrimSpace(header(message.Payload, "Precedence"))) {
	case "bulk", "list", "junk":
		signals.BulkPrecedence = true
	}
	return signals
}

func gmailMessageDirection(message gmailMessage) string {
	switch gmailMessageDirectionValue(message) {
	case "outbound":
		return "outbound (sent by mailbox owner)"
	case "draft":
		return "draft (not sent)"
	default:
		return "inbound (received by mailbox owner)"
	}
}

// visitBodyParts yields every non-attachment text/plain or text/html part
// with data, decoded to valid UTF-8, in document order.
func visitBodyParts(part gmailPart, yield func(mediaType, text string)) error {
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(part.MimeType, ";")[0]))
	disposition := strings.ToLower(header(part, "Content-Disposition"))
	if part.Filename != "" || strings.Contains(disposition, "attachment") {
		return nil
	}
	if part.Body.Data != "" && (mediaType == "text/plain" || mediaType == "text/html") {
		decoded, err := decodeBase64URL(part.Body.Data)
		if err != nil {
			return errors.New("Gmail message body is not valid base64url")
		}
		yield(mediaType, strings.ToValidUTF8(string(decoded), "\uFFFD"))
	}
	for _, child := range part.Parts {
		if err := visitBodyParts(child, yield); err != nil {
			return err
		}
	}
	return nil
}

func preferredBody(root gmailPart, maxBodyBytes int) (string, bool, error) {
	plain, rich := make([]string, 0), make([]string, 0)
	plainTruncated, richTruncated := false, false
	err := visitBodyParts(root, func(mediaType, text string) {
		if mediaType == "text/html" {
			text = htmlText(text)
		}
		truncated := len(text) > maxBodyBytes
		if truncated {
			text = string(truncateUTF8Bytes([]byte(text), maxBodyBytes))
		}
		if mediaType == "text/plain" {
			plain = append(plain, text)
			plainTruncated = plainTruncated || truncated
		} else {
			rich = append(rich, text)
			richTruncated = richTruncated || truncated
		}
	})
	if err != nil {
		return "", false, err
	}
	if strings.TrimSpace(strings.Join(plain, "\n")) != "" {
		return strings.Join(plain, "\n\n"), plainTruncated, nil
	}
	return strings.Join(rich, "\n\n"), richTruncated, nil
}

// authoredBody returns only the text the sender wrote in this message. It
// relies on structure, never on wording: HTML quote containers, RFC 3676 ">"
// quote lines, and the RFC 3676 "-- " signature delimiter. When unsure it keeps
// the text. HTML parts win over plain text because only HTML carries the quote
// structure.
func authoredBody(root gmailPart, maxBodyBytes int) (string, error) {
	plain, rich := make([]string, 0), make([]string, 0)
	err := visitBodyParts(root, func(mediaType, text string) {
		if mediaType == "text/html" {
			rich = append(rich, renderHTMLText(text, true))
		} else {
			plain = append(plain, text)
		}
	})
	if err != nil {
		return "", err
	}
	texts := plain
	if len(rich) > 0 {
		texts = rich
	}
	authored := make([]string, 0, len(texts))
	for _, text := range texts {
		if text = authoredText(text); text != "" {
			authored = append(authored, text)
		}
	}
	return string(truncateUTF8Bytes([]byte(strings.Join(authored, "\n\n")), maxBodyBytes)), nil
}

func authoredText(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	lines := make([]string, 0)
	for _, line := range strings.Split(value, "\n") {
		if !strings.HasPrefix(strings.TrimLeft(line, " \t"), ">") {
			lines = append(lines, line)
		}
	}
	for index := len(lines) - 1; index >= 0; index-- {
		if strings.TrimRight(lines[index], " \t") == "--" {
			lines = lines[:index]
			break
		}
	}
	output := make([]string, 0, len(lines))
	previousBlank := false
	for _, line := range lines {
		line = strings.TrimRight(line, " \t")
		blank := strings.TrimSpace(line) == ""
		if blank && previousBlank {
			continue
		}
		output = append(output, line)
		previousBlank = blank
	}
	return strings.TrimSpace(strings.Join(output, "\n"))
}

func truncateUTF8Bytes(value []byte, limit int) []byte {
	if limit <= 0 {
		return nil
	}
	if len(value) <= limit {
		return value
	}
	value = value[:limit]
	for len(value) > 0 && !utf8.Valid(value) {
		value = value[:len(value)-1]
	}
	return value
}

func decodeBase64URL(value string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err == nil {
		return decoded, nil
	}
	return base64.URLEncoding.DecodeString(value)
}

func htmlText(value string) string {
	return renderHTMLText(value, false)
}

// renderHTMLText flattens HTML to text lines. With authored set it also skips
// quoted history and forwarded content marked by mail-client structure.
func renderHTMLText(value string, authored bool) string {
	document, err := html.Parse(strings.NewReader(value))
	if err != nil {
		return ""
	}
	var output strings.Builder
	stopped := false
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if stopped {
			return
		}
		if node.Type == html.ElementNode {
			switch node.Data {
			case "head", "script", "style", "template":
				return
			}
			for _, attr := range node.Attr {
				style := strings.ToLower(strings.Join(strings.Fields(attr.Val), ""))
				if attr.Key == "hidden" || (attr.Key == "style" && (strings.Contains(style, "display:none") || strings.Contains(style, "visibility:hidden") || strings.Contains(style, "mso-hide:all"))) {
					return
				}
			}
			if authored {
				if htmlReplyHistoryStart(node) {
					stopped = true
					return
				}
				if htmlQuotedContent(node) {
					return
				}
			}
		}
		if node.Type == html.TextNode {
			output.WriteString(node.Data)
		}
		if node.Type == html.ElementNode && (node.Data == "br" || node.Data == "p" || node.Data == "div" || node.Data == "li") {
			output.WriteString("\n")
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
		if node.Type == html.ElementNode && (node.Data == "p" || node.Data == "div" || node.Data == "li") {
			output.WriteString("\n")
		}
	}
	walk(document)
	lines := strings.FieldsFunc(output.String(), func(r rune) bool { return r == '\r' || r == '\n' })
	for index := range lines {
		lines[index] = strings.Join(strings.Fields(lines[index]), " ")
	}
	return strings.Join(lines, "\n")
}

// htmlReplyHistoryStart marks Outlook's reply/forward history; it and
// everything after it in document order is not authored text.
func htmlReplyHistoryStart(node *html.Node) bool {
	switch htmlAttr(node, "id") {
	case "divRplyFwdMsg", "appendonsend", "mail-editor-reference-message-container":
		return true
	}
	return false
}

// htmlQuotedContent marks a subtree holding quoted or forwarded mail.
func htmlQuotedContent(node *html.Node) bool {
	if node.Data == "blockquote" {
		return true
	}
	classes := strings.Fields(htmlAttr(node, "class"))
	gmailQuote := false
	for _, class := range classes {
		switch class {
		case "gmail_attr", "moz-cite-prefix", "moz-forward-container", "yahoo_quoted":
			return true
		case "gmail_quote", "gmail_quote_container":
			gmailQuote = true
		}
	}
	// Gmail forwards are a gmail_quote without a blockquote; a reply container
	// is walked so text typed between inline quotes survives.
	return gmailQuote && !htmlHasBlockquote(node)
}

func htmlHasBlockquote(node *html.Node) bool {
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if (child.Type == html.ElementNode && child.Data == "blockquote") || htmlHasBlockquote(child) {
			return true
		}
	}
	return false
}

func htmlAttr(node *html.Node, key string) string {
	for _, attr := range node.Attr {
		if attr.Key == key {
			return attr.Val
		}
	}
	return ""
}

func header(part gmailPart, name string) string {
	for _, candidate := range part.Headers {
		if strings.EqualFold(candidate.Name, name) {
			return candidate.Value
		}
	}
	return ""
}

func messageTimestamp(message gmailMessage) string {
	if value := header(message.Payload, "Date"); value != "" {
		return singleLine(value)
	}
	if millis, err := strconv.ParseInt(message.InternalDate, 10, 64); err == nil {
		return time.UnixMilli(millis).UTC().Format(time.RFC3339)
	}
	return "unknown"
}

func singleLine(value string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value))
}

type GmailDraft struct {
	DraftID, MessageID, ThreadID string
}

// SaveGmailDraft stores a complete RFC 5322 message (base64url, as Gmail's
// raw field) as a new draft, or replaces draftID in place. It never sends.
func (c *Client) SaveGmailDraft(ctx context.Context, connectedAccountID, draftID, raw string) (GmailDraft, error) {
	request := map[string]any{"message": map[string]string{"raw": raw}}
	endpoint, method := "/gmail/v1/users/me/drafts", http.MethodPost
	if draftID != "" {
		request["id"] = draftID
		endpoint, method = "/gmail/v1/users/me/drafts/"+url.PathEscape(draftID), http.MethodPut
	}
	body, err := json.Marshal(request)
	if err != nil {
		return GmailDraft{}, err
	}
	var draft struct {
		ID      string `json:"id"`
		Message struct {
			ID       string `json:"id"`
			ThreadID string `json:"threadId"`
		} `json:"message"`
	}
	if err := c.proxy(ctx, proxyRequest{
		ConnectedAccountID: connectedAccountID, Endpoint: endpoint, Method: method, Body: body,
	}, &draft, "save Gmail draft"); err != nil {
		return GmailDraft{}, err
	}
	if draft.ID == "" || draftID != "" && draft.ID != draftID {
		return GmailDraft{}, errors.New("Gmail draft response was invalid")
	}
	return GmailDraft{DraftID: draft.ID, MessageID: draft.Message.ID, ThreadID: draft.Message.ThreadID}, nil
}
