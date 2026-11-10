package composio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type SlackIdentity struct{ TeamID, TeamName, TeamDomain, UserID string }

type SlackConversation struct {
	ID, Name, Kind string
	IsPrivate      bool
}

type SlackConversationPage struct {
	Conversations []SlackConversation
	NextCursor    string
}

type SlackImportOptions struct {
	Days, MaxMessagesPerConversation, MaxProviderCalls int
	WindowStart, WindowEnd                             time.Time
	IncludeThreadReplies                               bool
	BeforeProviderCall                                 func(context.Context, string) error
}

type SlackDocument struct {
	RemoteID, Filename string
	Markdown           []byte
}

var ErrSlackPageTokenInvalid = errors.New("Slack page cursor invalid")

type SlackAccessError struct{ Operation string }

func (e *SlackAccessError) Error() string { return "Slack access is unavailable for " + e.Operation }

type CoverageLimitError struct{ Operation string }

func (e *CoverageLimitError) Error() string { return "Slack coverage limit reached for " + e.Operation }

type slackResponse struct {
	OK               bool   `json:"ok"`
	Error            string `json:"error"`
	ResponseMetadata struct {
		NextCursor string `json:"next_cursor"`
	} `json:"response_metadata"`
}

func (c *Client) slackProxy(ctx context.Context, connectedAccountID, endpoint string, parameters []proxyParameter, target any, operation string) error {
	binding, err := c.authorizeConnection(ctx, connectedAccountID)
	if err != nil {
		return err
	}
	var response proxyResponse
	// Like proxy: project 2FA requires the owning user, taken from our authority.
	request := proxyRequest{ConnectedAccountID: connectedAccountID, UserID: binding.UserID, Endpoint: endpoint, Method: http.MethodGet, Parameters: parameters}
	if err := c.requestJSONOnce(ctx, http.MethodPost, "/api/v3.1/tools/execute/proxy", request, &response, operation); err != nil {
		var limited *RateLimitError
		if errors.As(err, &limited) {
			limited.Operation = strings.TrimPrefix(endpoint, "/")
		}
		return err
	}
	if response.Status == http.StatusTooManyRequests {
		return &RateLimitError{Operation: strings.TrimPrefix(endpoint, "/"), RetryAfter: parseRetryAfter(time.Now(), headerValue(response.Headers, "retry-after"), 0)}
	}
	if response.Status < 200 || response.Status >= 300 {
		return &remoteError{operation: operation, status: response.Status}
	}
	raw := response.Data
	var encoded string
	if len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, &encoded) == nil {
		raw = []byte(encoded)
	}
	var common slackResponse
	if err := json.Unmarshal(raw, &common); err != nil {
		return fmt.Errorf("Composio %s returned an invalid response", operation)
	}
	if !common.OK {
		if common.Error == "ratelimited" {
			return &RateLimitError{Operation: strings.TrimPrefix(endpoint, "/"), RetryAfter: parseRetryAfter(time.Now(), headerValue(response.Headers, "retry-after"), 0)}
		}
		switch common.Error {
		case "invalid_cursor":
			return ErrSlackPageTokenInvalid
		case "channel_not_found", "not_in_channel", "is_archived", "missing_scope":
			return &SlackAccessError{Operation: operation}
		}
		return errors.New("Slack " + operation + " failed")
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("Composio %s returned an invalid response", operation)
	}
	return nil
}

func (c *Client) IdentifySlack(ctx context.Context, connectedAccountID string) (SlackIdentity, error) {
	var response struct {
		slackResponse
		TeamID string `json:"team_id"`
		Team   string `json:"team"`
		URL    string `json:"url"`
		UserID string `json:"user_id"`
	}
	if err := c.slackProxy(ctx, connectedAccountID, "/auth.test", nil, &response, "identify Slack account"); err != nil {
		return SlackIdentity{}, err
	}
	domain := strings.TrimSuffix(strings.TrimPrefix(response.URL, "https://"), ".slack.com/")
	if response.TeamID == "" || response.UserID == "" {
		return SlackIdentity{}, errors.New("Slack auth.test returned an invalid response")
	}
	return SlackIdentity{TeamID: response.TeamID, TeamName: response.Team, TeamDomain: domain, UserID: response.UserID}, nil
}

func (c *Client) ListSlackConversations(ctx context.Context, connectedAccountID, cursor string, limit int) (SlackConversationPage, error) {
	if limit < 1 || limit > 200 {
		return SlackConversationPage{}, errors.New("invalid Slack conversation page limit")
	}
	parameters := []proxyParameter{{Name: "types", Value: "public_channel,private_channel", Type: "query"}, {Name: "exclude_archived", Value: "true", Type: "query"}, {Name: "limit", Value: strconv.Itoa(limit), Type: "query"}}
	if cursor != "" {
		parameters = append(parameters, proxyParameter{Name: "cursor", Value: cursor, Type: "query"})
	}
	var wire struct {
		slackResponse
		Channels []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			IsPrivate bool   `json:"is_private"`
			IsMember  bool   `json:"is_member"`
			IsIM      bool   `json:"is_im"`
			IsMPIM    bool   `json:"is_mpim"`
		} `json:"channels"`
	}
	if err := c.slackProxy(ctx, connectedAccountID, "/conversations.list", parameters, &wire, "list Slack conversations"); err != nil {
		return SlackConversationPage{}, err
	}
	page := SlackConversationPage{NextCursor: wire.ResponseMetadata.NextCursor}
	for _, channel := range wire.Channels {
		if channel.IsIM || channel.IsMPIM || !channel.IsMember {
			continue
		}
		kind := "public_channel"
		if channel.IsPrivate {
			kind = "private_channel"
		}
		name := channel.Name
		if name == "" {
			name = channel.ID
		}
		page.Conversations = append(page.Conversations, SlackConversation{ID: channel.ID, Name: name, Kind: kind, IsPrivate: channel.IsPrivate})
	}
	return page, nil
}

type slackMessage struct {
	Type     string `json:"type"`
	Subtype  string `json:"subtype"`
	User     string `json:"user"`
	BotID    string `json:"bot_id"`
	Username string `json:"username"`
	Text     string `json:"text"`
	TS       string `json:"ts"`
	ThreadTS string `json:"thread_ts"`
	Edited   *struct {
		TS string `json:"ts"`
	} `json:"edited"`
	Files []struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Mimetype  string `json:"mimetype"`
		Filetype  string `json:"filetype"`
		Permalink string `json:"permalink"`
	} `json:"files"`
	Blocks      json.RawMessage `json:"blocks"`
	Attachments json.RawMessage `json:"attachments"`
	ReplyCount  int             `json:"reply_count"`
}

func (c *Client) FetchSlackDocuments(ctx context.Context, connectedAccountID string, identity SlackIdentity, conversations []SlackConversation, options SlackImportOptions) ([]SlackDocument, int, error) {
	if options.Days < 1 || options.Days > 30 || options.MaxMessagesPerConversation < 1 || options.MaxProviderCalls < 1 {
		return nil, 0, errors.New("invalid Slack import options")
	}
	calls := 0
	documents := make([]SlackDocument, 0)
	users := map[string]string{}
	for _, conversation := range conversations {
		if calls >= options.MaxProviderCalls {
			return nil, calls, &CoverageLimitError{Operation: "provider call budget"}
		}
		messages, used, err := c.fetchSlackHistory(ctx, connectedAccountID, conversation.ID, options, options.MaxProviderCalls-calls)
		calls += used
		if err != nil {
			return nil, calls, err
		}
		if options.IncludeThreadReplies {
			for index := range messages {
				if messages[index].ReplyCount == 0 || messages[index].ThreadTS != "" {
					continue
				}
				if calls >= options.MaxProviderCalls {
					return nil, calls, &CoverageLimitError{Operation: "thread reply call budget"}
				}
				replies, err := c.fetchSlackReplies(ctx, connectedAccountID, conversation.ID, messages[index].TS, options, options.MaxProviderCalls-calls)
				calls += replies.calls
				if err != nil {
					return nil, calls, err
				}
				messages[index].replies = replies.messages
			}
		}
		for _, message := range messages {
			collectSlackUsers(message, users)
		}
		for userID, display := range users {
			if display != userID || calls >= options.MaxProviderCalls {
				continue
			}
			calls++
			if options.BeforeProviderCall != nil {
				if err := options.BeforeProviderCall(ctx, "users.info"); err != nil {
					return nil, calls, err
				}
			}
			name, lookupErr := c.lookupSlackUser(ctx, connectedAccountID, userID)
			if lookupErr == nil && name != "" {
				users[userID] = name + " (`" + userID + "`)"
			}
		}
		docs, err := renderSlackConversation(identity, conversation, messages, users, c.maxThreadBytes)
		if err != nil {
			return nil, calls, err
		}
		documents = append(documents, docs...)
	}
	total := 0
	for _, document := range documents {
		total += len(document.Markdown)
		if total > c.maxBatchBytes {
			return nil, calls, &CoverageLimitError{Operation: "batch size"}
		}
	}
	return documents, calls, nil
}

func (c *Client) lookupSlackUser(ctx context.Context, connectedAccountID, userID string) (string, error) {
	var wire struct {
		slackResponse
		User struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			RealName string `json:"real_name"`
			Profile  struct {
				DisplayName string `json:"display_name"`
				RealName    string `json:"real_name"`
			} `json:"profile"`
		} `json:"user"`
	}
	if err := c.slackProxy(ctx, connectedAccountID, "/users.info", []proxyParameter{{Name: "user", Value: userID, Type: "query"}}, &wire, "lookup Slack user"); err != nil {
		return "", err
	}
	for _, candidate := range []string{wire.User.Profile.DisplayName, wire.User.Profile.RealName, wire.User.RealName, wire.User.Name} {
		if strings.TrimSpace(candidate) != "" {
			return safeSlackText(candidate), nil
		}
	}
	return userID, nil
}

type slackThreadMessage struct {
	slackMessage
	replies []slackMessage
}

func (c *Client) fetchSlackHistory(ctx context.Context, ca, channel string, options SlackImportOptions, budget int) ([]slackThreadMessage, int, error) {
	windowStart, windowEnd := options.WindowStart, options.WindowEnd
	if windowStart.IsZero() || windowEnd.IsZero() {
		windowEnd = time.Now().UTC()
		windowStart = windowEnd.AddDate(0, 0, -options.Days)
	}
	oldest := strconv.FormatInt(windowStart.UTC().Unix(), 10)
	latest := strconv.FormatInt(windowEnd.UTC().Unix(), 10)
	cursor := ""
	result := []slackThreadMessage{}
	calls := 0
	for len(result) < options.MaxMessagesPerConversation {
		if calls >= budget {
			return nil, calls, &CoverageLimitError{Operation: "history call budget"}
		}
		pageSize := min(15, options.MaxMessagesPerConversation-len(result))
		params := []proxyParameter{{Name: "channel", Value: channel, Type: "query"}, {Name: "oldest", Value: oldest, Type: "query"}, {Name: "latest", Value: latest, Type: "query"}, {Name: "limit", Value: strconv.Itoa(pageSize), Type: "query"}, {Name: "inclusive", Value: "true", Type: "query"}}
		if cursor != "" {
			params = append(params, proxyParameter{Name: "cursor", Value: cursor, Type: "query"})
		}
		var page struct {
			slackResponse
			Messages []slackMessage `json:"messages"`
			HasMore  bool           `json:"has_more"`
		}
		calls++
		if options.BeforeProviderCall != nil {
			if err := options.BeforeProviderCall(ctx, "conversations.history"); err != nil {
				return nil, calls, err
			}
		}
		if err := c.slackProxy(ctx, ca, "/conversations.history", params, &page, "fetch Slack history"); err != nil {
			return nil, calls, err
		}
		for _, m := range page.Messages {
			result = append(result, slackThreadMessage{slackMessage: m})
			if len(result) >= options.MaxMessagesPerConversation {
				break
			}
		}
		cursor = page.ResponseMetadata.NextCursor
		if cursor == "" || len(page.Messages) == 0 {
			break
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].TS < result[j].TS })
	return result, calls, nil
}

type slackRepliesResult struct {
	messages []slackMessage
	calls    int
}

func (c *Client) fetchSlackReplies(ctx context.Context, ca, channel, ts string, options SlackImportOptions, budget int) (slackRepliesResult, error) {
	result := slackRepliesResult{}
	cursor := ""
	for {
		if result.calls >= budget {
			return result, &CoverageLimitError{Operation: "reply call budget"}
		}
		params := []proxyParameter{{Name: "channel", Value: channel, Type: "query"}, {Name: "ts", Value: ts, Type: "query"}, {Name: "limit", Value: "15", Type: "query"}}
		if cursor != "" {
			params = append(params, proxyParameter{Name: "cursor", Value: cursor, Type: "query"})
		}
		var page struct {
			slackResponse
			Messages []slackMessage `json:"messages"`
		}
		result.calls++
		if options.BeforeProviderCall != nil {
			if err := options.BeforeProviderCall(ctx, "conversations.replies"); err != nil {
				return result, err
			}
		}
		if err := c.slackProxy(ctx, ca, "/conversations.replies", params, &page, "fetch Slack thread replies"); err != nil {
			return result, err
		}
		for _, message := range page.Messages {
			if message.TS != ts {
				result.messages = append(result.messages, message)
			}
		}
		cursor = page.ResponseMetadata.NextCursor
		if cursor == "" || len(page.Messages) == 0 {
			break
		}
	}
	sort.Slice(result.messages, func(i, j int) bool { return result.messages[i].TS < result.messages[j].TS })
	return result, nil
}

func collectSlackUsers(message slackThreadMessage, users map[string]string) {
	if message.User != "" {
		users[message.User] = message.User
	}
	for _, reply := range message.replies {
		if reply.User != "" {
			users[reply.User] = reply.User
		}
	}
}

func renderSlackConversation(identity SlackIdentity, conversation SlackConversation, messages []slackThreadMessage, users map[string]string, maxBytes int) ([]SlackDocument, error) {
	byDay := map[string][]slackThreadMessage{}
	for _, message := range messages {
		stamp, err := slackTimestamp(message.TS)
		if err != nil {
			return nil, err
		}
		day := stamp.UTC().Format("2006-01-02")
		byDay[day] = append(byDay[day], message)
	}
	days := make([]string, 0, len(byDay))
	for day := range byDay {
		days = append(days, day)
	}
	sort.Strings(days)
	docs := make([]SlackDocument, 0, len(days))
	for _, day := range days {
		var output strings.Builder
		fmt.Fprintf(&output, "# Slack %s — %s\n\n- Workspace: %s (`%s`)\n- Conversation: %s (`%s`, %s)\n- UTC date: %s\n\n", conversation.Name, day, safeSlackText(identity.TeamName), identity.TeamID, safeSlackText(conversation.Name), conversation.ID, conversation.Kind, day)
		for _, message := range byDay[day] {
			renderSlackMessage(&output, identity, conversation, message.slackMessage, users, false)
			for _, reply := range message.replies {
				renderSlackMessage(&output, identity, conversation, reply, users, true)
			}
			if output.Len() > maxBytes {
				return nil, &CoverageLimitError{Operation: "daily document size"}
			}
		}
		content := []byte(output.String())
		if !utf8.Valid(content) {
			return nil, errors.New("Slack daily document is not valid UTF-8")
		}
		remote := fmt.Sprintf("slack:%s:%s:%s", identity.TeamID, conversation.ID, day)
		docs = append(docs, SlackDocument{RemoteID: remote, Filename: "slack-" + conversation.ID + "-" + day + ".md", Markdown: content})
	}
	return docs, nil
}
func renderSlackMessage(output *strings.Builder, identity SlackIdentity, conversation SlackConversation, message slackMessage, users map[string]string, reply bool) {
	stamp, _ := slackTimestamp(message.TS)
	heading := "Message"
	if reply {
		heading = "Reply"
	}
	author := message.User
	if author == "" {
		author = message.Username
	}
	if author == "" {
		author = message.BotID
	}
	if author == "" {
		author = "system"
	}
	domain := identity.TeamDomain
	if domain == "" {
		domain = "app"
	}
	permalink := fmt.Sprintf("https://%s.slack.com/archives/%s/p%s", domain, conversation.ID, strings.ReplaceAll(message.TS, ".", ""))
	fmt.Fprintf(output, "## %s %s\n\n- Message ID: `%s`\n- Thread ID: `%s`\n- Time: %s\n- Participant: %s\n- Permalink: %s\n", heading, message.TS, message.TS, threadID(message), stamp.UTC().Format(time.RFC3339), safeSlackText(users[author]), permalink)
	if message.Edited != nil {
		output.WriteString("- Edited: true\n")
	}
	if message.Subtype == "message_deleted" {
		output.WriteString("- Deleted: true\n")
	}
	text := message.Text
	if strings.TrimSpace(text) == "" {
		text = fallbackSlackText(message.Blocks, message.Attachments)
	}
	fmt.Fprintf(output, "\n%s\n", safeSlackText(text))
	for _, file := range message.Files {
		fmt.Fprintf(output, "\n- File: %s; MIME: %s; type: %s; permalink: %s\n", safeSlackText(file.Name), safeSlackText(file.Mimetype), safeSlackText(file.Filetype), safeSlackText(file.Permalink))
	}
	output.WriteString("\n")
}
func threadID(message slackMessage) string {
	if message.ThreadTS != "" {
		return message.ThreadTS
	}
	return message.TS
}
func slackTimestamp(value string) (time.Time, error) {
	parts := strings.SplitN(value, ".", 2)
	seconds, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return time.Time{}, errors.New("Slack message has invalid timestamp")
	}
	return time.Unix(seconds, 0).UTC(), nil
}
func fallbackSlackText(blocks, attachments json.RawMessage) string {
	// Optional external Slack fields: unparseable or absent blocks only drop the fallback text.
	var values []any
	_ = json.Unmarshal(blocks, &values)
	var attachmentsValues []any
	_ = json.Unmarshal(attachments, &attachmentsValues)
	values = append(values, attachmentsValues...)
	parts := []string{}
	var walk func(any)
	walk = func(value any) {
		switch typed := value.(type) {
		case map[string]any:
			for _, key := range []string{"text", "fallback", "title", "value"} {
				if text, ok := typed[key].(string); ok && text != "" {
					parts = append(parts, text)
				}
			}
			for _, child := range typed {
				walk(child)
			}
		case []any:
			for _, child := range typed {
				walk(child)
			}
		}
	}
	walk(values)
	return strings.Join(parts, " ")
}
func safeSlackText(value string) string {
	value = strings.ToValidUTF8(value, "[invalid UTF-8]")
	value = html.UnescapeString(value)
	value = strings.ReplaceAll(value, "<!channel>", "@channel")
	value = strings.ReplaceAll(value, "<!here>", "@here")
	value = strings.ReplaceAll(value, "<!everyone>", "@everyone")
	value = slackReferencePattern.ReplaceAllStringFunc(value, func(reference string) string {
		body := strings.TrimSuffix(strings.TrimPrefix(reference, "<"), ">")
		parts := strings.SplitN(body, "|", 2)
		target := parts[0]
		if strings.HasPrefix(target, "@") {
			return target
		}
		if strings.HasPrefix(target, "#") {
			if len(parts) == 2 {
				return "#" + parts[1]
			}
			return target
		}
		if len(parts) == 2 && (strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://")) {
			return "[" + parts[1] + "](" + target + ")"
		}
		return target
	})
	return strings.TrimSpace(value)
}

var slackReferencePattern = regexp.MustCompile(`<(?:@[^>]+|#[^>]+|https?://[^>]+)>`)
