package composio

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/emailevidence"
	"golang.org/x/sync/errgroup"
)

const MailImportMaxMessages = 3000

// MailImportPageOptions freezes the window across pages and worker retries.
type MailImportPageOptions struct {
	Start, End         time.Time
	Cursor             string
	Limit              int
	BeforeProviderCall func(context.Context, string) error
}

type MailImportPage struct {
	Documents  []AppDocument
	NextCursor string
	// Read counts listed messages, including Skipped unreadable ones, so pagination stays exact.
	Read    int
	Skipped int
}

// MailImportStart uses calendar months, clamping month-end dates.
func MailImportStart(end time.Time) time.Time {
	month := time.Date(end.Year(), end.Month()-6, 1, end.Hour(), end.Minute(), end.Second(), end.Nanosecond(), end.Location())
	lastDay := month.AddDate(0, 1, -1).Day()
	return month.AddDate(0, 0, min(end.Day(), lastDay)-1)
}

func (c *Client) FetchMailImportPage(ctx context.Context, accountID, provider string, options MailImportPageOptions) (MailImportPage, error) {
	if options.Start.IsZero() || !options.Start.Before(options.End) || options.Limit < 1 || options.Limit > 100 {
		return MailImportPage{}, errors.New("invalid mail import page")
	}
	switch provider {
	case "gmail":
		return c.fetchGmailImportPage(ctx, accountID, options)
	case "outlook":
		return c.fetchOutlookImportPage(ctx, accountID, options)
	default:
		return MailImportPage{}, errors.New("unsupported mail provider")
	}
}

func (c *Client) mailImportCall(ctx context.Context, options MailImportPageOptions, request proxyRequest, result any, operation string) error {
	if options.BeforeProviderCall != nil {
		if err := options.BeforeProviderCall(ctx, operation); err != nil {
			return err
		}
	}
	return c.proxy(ctx, request, result, operation)
}

// Gmail's Primary category is a search operator: the CATEGORY_PERSONAL label
// misses most Primary mail, and no category matches the owner's sent mail.
func (c *Client) fetchGmailImportPage(ctx context.Context, accountID string, options MailImportPageOptions) (MailImportPage, error) {
	parameters := []proxyParameter{
		{Name: "q", Value: fmt.Sprintf("after:%d before:%d -in:spam -in:trash -in:drafts {category:primary in:sent}", options.Start.Unix(), options.End.Unix()), Type: "query"},
		{Name: "maxResults", Value: strconv.Itoa(options.Limit), Type: "query"},
	}
	if options.Cursor != "" {
		parameters = append(parameters, proxyParameter{Name: "pageToken", Value: options.Cursor, Type: "query"})
	}
	var list struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
		Next string `json:"nextPageToken"`
	}
	if err := c.mailImportCall(ctx, options, proxyRequest{ConnectedAccountID: accountID, Endpoint: "/gmail/v1/users/me/messages", Method: http.MethodGet, Parameters: parameters}, &list, "list mail import messages"); err != nil {
		return MailImportPage{}, err
	}
	if len(list.Messages) > options.Limit || list.Next != "" && list.Next == options.Cursor {
		return MailImportPage{}, errors.New("invalid Gmail mail import continuation")
	}
	page := MailImportPage{NextCursor: list.Next, Read: len(list.Messages)}
	documents := make([]AppDocument, len(list.Messages))
	skipped := make([]bool, len(list.Messages))
	group, callCtx := errgroup.WithContext(ctx)
	group.SetLimit(max(1, c.fetchConcurrency))
	for index, item := range list.Messages {
		group.Go(func() error {
			document, err := c.fetchGmailImportMessage(callCtx, accountID, item.ID, options)
			if errors.Is(err, errUnreadableMailMessage) {
				skipped[index] = true
				return nil
			}
			documents[index] = document
			return err
		})
	}
	if err := group.Wait(); err != nil {
		return MailImportPage{}, err
	}
	for index, document := range documents {
		if skipped[index] {
			page.Skipped++
		}
		if document.RemoteID != "" {
			page.Documents = append(page.Documents, document)
		}
	}
	return page, nil
}

// errUnreadableMailMessage marks a message that can never be read (oversized,
// malformed, or unrenderable); the import counts it as skipped and continues.
var errUnreadableMailMessage = errors.New("mail message can never be read")

// fetchGmailImportMessage returns errUnreadableMailMessage for a message that
// can never be read; transient failures stay other errors. A deleted message or
// one outside the import window or kept out by the whitelist returns no
// document and no error; a filtered sender's body is never read.
func (c *Client) fetchGmailImportMessage(ctx context.Context, accountID, id string, options MailImportPageOptions) (AppDocument, error) {
	if id == "" {
		return AppDocument{}, errors.New("Gmail message is missing its ID")
	}
	var message gmailMessage
	err := c.mailImportCall(ctx, options, proxyRequest{ConnectedAccountID: accountID, Endpoint: "/gmail/v1/users/me/messages/" + url.PathEscape(id), Method: http.MethodGet, Parameters: []proxyParameter{{Name: "format", Value: "full", Type: "query"}}}, &message, "read mail import message")
	if err != nil {
		var remote *remoteError
		if errors.As(err, &remote) && remote.status == http.StatusNotFound {
			return AppDocument{}, nil
		}
		if errors.Is(err, ErrResponseTooLarge) {
			return AppDocument{}, fmt.Errorf("%w: %w", errUnreadableMailMessage, err)
		}
		return AppDocument{}, err
	}
	if message.ID != id {
		return AppDocument{}, fmt.Errorf("%w: Gmail returned message %q for %q", errUnreadableMailMessage, message.ID, id)
	}
	ts, err := strconv.ParseInt(message.InternalDate, 10, 64)
	if err != nil {
		return AppDocument{}, fmt.Errorf("%w: internal date: %w", errUnreadableMailMessage, err)
	}
	direction := gmailMessageDirectionValue(message)
	if time.UnixMilli(ts).Before(options.Start) || !time.UnixMilli(ts).Before(options.End) || gmailMessageExcluded(message) || direction == "draft" {
		return AppDocument{}, nil
	}
	if direction != "outbound" && filteredSender(header(message.Payload, "From")) {
		return AppDocument{}, nil
	}
	if options.BeforeProviderCall != nil {
		if err = options.BeforeProviderCall(ctx, "read mail body"); err != nil {
			return AppDocument{}, err
		}
	}
	if _, err = c.hydrateGmailPollBody(ctx, accountID, message.ID, &message.Payload); err != nil {
		return AppDocument{}, err
	}
	document, err := c.renderImportedMail("gmail", message)
	if err != nil {
		return AppDocument{}, fmt.Errorf("%w: %w", errUnreadableMailMessage, err)
	}
	return document, nil
}

type outlookImportCursor struct {
	Link          string `json:"link"`
	Email         string `json:"email"`
	Junk, Deleted string
}

func (c *Client) fetchOutlookImportPage(ctx context.Context, accountID string, options MailImportPageOptions) (MailImportPage, error) {
	var cursor outlookImportCursor
	if options.Cursor != "" {
		if err := json.Unmarshal([]byte(options.Cursor), &cursor); err != nil {
			return MailImportPage{}, errors.New("invalid Outlook import cursor")
		}
	} else {
		identity, err := c.IdentifyOutlook(ctx, accountID)
		if err != nil {
			return MailImportPage{}, err
		}
		cursor.Email = strings.ToLower(strings.TrimSpace(identity.Label))
		for _, folder := range []struct {
			name   string
			target *string
		}{{"junkemail", &cursor.Junk}, {"deleteditems", &cursor.Deleted}} {
			var response struct {
				ID string `json:"id"`
			}
			if err = c.mailImportCall(ctx, options, proxyRequest{ConnectedAccountID: accountID, Endpoint: "/v1.0/me/mailFolders/" + folder.name, Method: http.MethodGet, Parameters: []proxyParameter{{Name: "$select", Value: "id", Type: "query"}}}, &response, "read Outlook excluded folder"); err != nil {
				return MailImportPage{}, err
			}
			if response.ID == "" {
				return MailImportPage{}, errors.New("Outlook folder has no ID")
			}
			*folder.target = response.ID
		}
	}
	if cursor.Email == "" || cursor.Junk == "" || cursor.Deleted == "" {
		return MailImportPage{}, errors.New("incomplete Outlook import cursor")
	}
	request, err := graphPollRequest(accountID, cursor.Link)
	if err != nil {
		return MailImportPage{}, err
	}
	if cursor.Link != "" && request.Endpoint != "/v1.0/me/messages" {
		return MailImportPage{}, errors.New("invalid Outlook import continuation endpoint")
	}
	if cursor.Link == "" {
		request.Endpoint = "/v1.0/me/messages"
		request.Parameters = []proxyParameter{
			{Name: "$filter", Value: fmt.Sprintf("receivedDateTime ge %s and receivedDateTime lt %s and isDraft eq false and parentFolderId ne '%s' and parentFolderId ne '%s'", options.Start.UTC().Format(time.RFC3339), options.End.UTC().Format(time.RFC3339), strings.ReplaceAll(cursor.Junk, "'", "''"), strings.ReplaceAll(cursor.Deleted, "'", "''")), Type: "query"},
			{Name: "$orderby", Value: "receivedDateTime desc", Type: "query"},
			{Name: "$top", Value: strconv.Itoa(options.Limit), Type: "query"},
			{Name: "$select", Value: "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,parentFolderId,isDraft,inferenceClassification,body,internetMessageHeaders", Type: "query"},
		}
	}
	// Keep the provider continuation intact while reducing the last page to the remaining allowance.
	for i := range request.Parameters {
		if request.Parameters[i].Name == "$top" {
			request.Parameters[i].Value = strconv.Itoa(options.Limit)
		}
	}
	var wire struct {
		Messages []struct {
			ID, ConversationID, Subject, ParentFolderID, ReceivedDateTime string
			InferenceClassification                                       string
			IsDraft                                                       bool
			From                                                          outlookRecipient
			ToRecipients, CcRecipients                                    []outlookRecipient
			Body                                                          struct{ ContentType, Content string }
			InternetMessageHeaders                                        []struct{ Name, Value string }
		} `json:"value"`
		Next string `json:"@odata.nextLink"`
	}
	if err = c.mailImportCall(ctx, options, request, &wire, "list Outlook import messages"); err != nil {
		return MailImportPage{}, err
	}
	if len(wire.Messages) > options.Limit || wire.Next != "" && wire.Next == cursor.Link {
		return MailImportPage{}, errors.New("invalid Outlook import continuation")
	}
	page := MailImportPage{Read: len(wire.Messages)}
	for _, item := range wire.Messages {
		received, err := time.Parse(time.RFC3339Nano, item.ReceivedDateTime)
		if err != nil || item.ID == "" {
			page.Skipped++
			continue
		}
		owner := strings.EqualFold(item.From.EmailAddress.Address, cursor.Email)
		// Focused is filtered here rather than in $filter, which Graph may
		// refuse beside the received-time order; the owner's mail always enters.
		if item.IsDraft || item.ParentFolderID == cursor.Junk || item.ParentFolderID == cursor.Deleted || received.Before(options.Start) || !received.Before(options.End) ||
			!owner && !strings.EqualFold(item.InferenceClassification, "focused") {
			continue
		}
		if !owner && filteredSender(item.From.String()) {
			continue
		}
		message := gmailMessage{ID: item.ID, ThreadID: item.ConversationID, InternalDate: strconv.FormatInt(received.UnixMilli(), 10)}
		message.Payload.MimeType = "text/plain"
		if strings.EqualFold(item.Body.ContentType, "html") {
			message.Payload.MimeType = "text/html"
		}
		message.Payload.Body.Data = base64.RawURLEncoding.EncodeToString([]byte(item.Body.Content))
		addHeader := func(name, value string) {
			message.Payload.Headers = append(message.Payload.Headers, struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			}{name, value})
		}
		addHeader("Subject", item.Subject)
		addHeader("From", item.From.String())
		for name, recipients := range map[string][]outlookRecipient{"To": item.ToRecipients, "Cc": item.CcRecipients} {
			values := make([]string, 0, len(recipients))
			for _, recipient := range recipients {
				values = append(values, recipient.String())
			}
			addHeader(name, strings.Join(values, ", "))
		}
		for _, header := range item.InternetMessageHeaders {
			if !strings.EqualFold(header.Name, "Subject") && !strings.EqualFold(header.Name, "From") && !strings.EqualFold(header.Name, "To") && !strings.EqualFold(header.Name, "Cc") {
				addHeader(header.Name, header.Value)
			}
		}
		if owner {
			message.LabelIDs = []string{"SENT"}
		}
		document, err := c.renderImportedMail("outlook", message)
		if err != nil {
			page.Skipped++
			continue
		}
		page.Documents = append(page.Documents, document)
	}
	if wire.Next != "" {
		cursor.Link = wire.Next
		raw, _ := json.Marshal(cursor)
		page.NextCursor = string(raw)
	}
	return page, nil
}

func (c *Client) renderImportedMail(provider string, message gmailMessage) (AppDocument, error) {
	// Bound each message independently; model input selection has its own budget.
	bodyLimit := min(c.maxBodyBytes, 64<<10)
	body, truncated, err := preferredBody(message.Payload, bodyLimit)
	if err != nil {
		return AppDocument{}, err
	}
	body = withoutLinkTracking(body)
	var output strings.Builder
	fmt.Fprintf(&output, "# %s\n\n- Provider: %s\n- Message ID: `%s`\n- Thread ID: `%s`\n- Timestamp: %s\n- Direction: %s\n", singleLine(header(message.Payload, "Subject")), provider, message.ID, message.ThreadID, messageTimestamp(message), gmailMessageDirection(message))
	for _, name := range []string{"From", "To", "Cc"} {
		fmt.Fprintf(&output, "- %s: %s\n", name, singleLine(header(message.Payload, name)))
	}
	if truncated {
		output.WriteString("- Body: truncated at the configured import limit\n")
	}
	authored, err := authoredBody(message.Payload, bodyLimit)
	if err != nil {
		return AppDocument{}, err
	}
	automated := emailevidence.AutomatedClass(gmailMessageSignals(message))
	profile := profileMailView(output.String(), withoutLinkTracking(authored), body, automated, gmailMessageDirectionValue(message) == "outbound")
	output.WriteString("\n" + body + "\n")
	payload := gmailThreadPayload{ID: message.ThreadID, Messages: []gmailMessage{message}}
	if payload.ID == "" {
		payload.ID = message.ID
	}
	insight, err := renderGmailInsightEvidence(payload, bodyLimit, c.maxThreadBytes)
	if err != nil {
		return AppDocument{}, err
	}
	name := fmt.Sprintf("%s-message-%x.md", provider, sha256.Sum256([]byte(message.ID)))
	return AppDocument{RemoteID: "message:" + message.ID, Filename: name, Markdown: []byte(output.String()), ProfileMarkdown: profile, Automated: automated != "", InsightEvidence: insight}, nil
}

// profileMailView is the whole message as the Profile reads it, marked so the
// model can tell the sender's new words from quoted, forwarded or signature
// text, and automated mail from mail a person wrote. Automated mail keeps its
// full text: it can support facts, never style. The Wiki keeps the message
// unmarked in Markdown.
func profileMailView(header, authored, body string, automated emailevidence.MessageClass, outbound bool) []byte {
	authored, body = strings.TrimSpace(authored), strings.TrimSpace(body)
	var out strings.Builder
	out.WriteString(header)
	if automated != "" {
		fmt.Fprintf(&out, "- Kind: automated (%s)\n", strings.ReplaceAll(string(automated), "_", " "))
	} else if authored != "" {
		if outbound {
			out.WriteString("\n## Written by the subject in this message\n\n")
		} else {
			out.WriteString("\n## Written by the sender of this message\n\n")
		}
		out.WriteString(authored + "\n")
	}
	if body != "" && (automated != "" || body != authored) {
		out.WriteString("\n## Full message text, including any quoted earlier messages, forwarded text and signature\n\n" + body + "\n")
	}
	if automated == "" && authored == "" && body == "" {
		return nil
	}
	return []byte(out.String())
}

type OutlookIdentity struct {
	ID, Label string
}

// IdentifyOutlook returns the signed-in mailbox, which also tells sent mail from received mail.
func (c *Client) IdentifyOutlook(ctx context.Context, accountID string) (OutlookIdentity, error) {
	var wire struct {
		ID        string `json:"id"`
		Mail      string `json:"mail"`
		Principal string `json:"userPrincipalName"`
	}
	if err := c.proxy(ctx, proxyRequest{ConnectedAccountID: accountID, Endpoint: "https://graph.microsoft.com/v1.0/me", Method: http.MethodGet, Parameters: []proxyParameter{{Name: "$select", Value: "id,mail,userPrincipalName", Type: "query"}}}, &wire, "identify Outlook account"); err != nil {
		return OutlookIdentity{}, err
	}
	label := wire.Mail
	if label == "" {
		label = wire.Principal
	}
	if wire.ID == "" || label == "" {
		return OutlookIdentity{}, errors.New("Outlook identity response was incomplete")
	}
	return OutlookIdentity{wire.ID, label}, nil
}
