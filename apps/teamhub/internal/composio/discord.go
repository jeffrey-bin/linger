package composio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type DiscordIdentity struct {
	GuildID, GuildName string
}

var (
	ErrDiscordGuildRequired      = errors.New("Discord server must be selected")
	ErrDiscordGuildNotAccessible = errors.New("Discord server is not accessible")
)

type DiscordChannel struct {
	ID, GuildID, ParentID, Name string
	Type                        int
	ArchivedAt                  time.Time
}

type DiscordThreadPage struct {
	Threads    []DiscordChannel
	NextCursor string
}

type DiscordAttachment struct {
	ID, Filename, URL string
}

type DiscordMessage struct {
	ID, ChannelID, ParentChannelID, ChannelName, ThreadName string
	Content, AuthorID, AuthorName                           string
	Timestamp, EditedTimestamp                              time.Time
	Type                                                    int
	AuthorBot                                               bool
	Attachments                                             []DiscordAttachment
}

type DiscordMessagePage struct {
	Messages   []DiscordMessage
	NextBefore string
}

func (c *Client) IdentifyDiscord(ctx context.Context, connectedAccountID string) (DiscordIdentity, error) {
	if _, err := c.authorizeConnection(ctx, connectedAccountID); err != nil {
		return DiscordIdentity{}, err
	}
	var account struct {
		Toolkit struct {
			Slug string `json:"slug"`
		} `json:"toolkit"`
		State *struct {
			Val json.RawMessage `json:"val"`
		} `json:"state"`
	}
	endpoint := "/api/v3.1/connected_accounts/" + url.PathEscape(connectedAccountID)
	if err := c.requestJSON(ctx, http.MethodGet, endpoint, nil, &account, "identify Discord installation"); err != nil {
		return DiscordIdentity{}, err
	}
	if account.Toolkit.Slug != "discordbot" || account.State == nil {
		return DiscordIdentity{}, errors.New("Discord installation response was incomplete")
	}
	var state struct {
		Guild struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"guild"`
		GuildID string `json:"guild_id"`
		OAuth2  struct {
			Guild struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"guild"`
		} `json:"oauth2"`
	}
	payload := account.State.Val
	var encoded string
	if len(payload) > 0 && payload[0] == '"' && json.Unmarshal(payload, &encoded) == nil {
		payload = []byte(encoded)
	}
	if err := json.Unmarshal(payload, &state); err != nil {
		return DiscordIdentity{}, errors.New("Discord installation state was invalid")
	}
	guildID, guildName := state.Guild.ID, state.Guild.Name
	if guildID == "" {
		guildID = state.OAuth2.Guild.ID
		guildName = state.OAuth2.Guild.Name
	}
	if guildID == "" {
		guildID = state.GuildID
	}
	if guildID == "" || strings.EqualFold(strings.TrimSpace(guildID), "REDACTED") {
		return DiscordIdentity{}, ErrDiscordGuildRequired
	}
	guild, err := c.GetDiscordGuild(ctx, connectedAccountID, guildID)
	if err != nil {
		return DiscordIdentity{}, err
	}
	if guild.GuildName != "" {
		guildName = guild.GuildName
	}
	if strings.TrimSpace(guildName) == "" {
		return DiscordIdentity{}, errors.New("Discord installation guild name was missing")
	}
	return DiscordIdentity{GuildID: guildID, GuildName: guildName}, nil
}

func (c *Client) GetDiscordGuild(ctx context.Context, connectedAccountID, guildID string) (DiscordIdentity, error) {
	if guildID == "" {
		return DiscordIdentity{}, errors.New("Discord guild id is required")
	}
	var wire struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	endpoint := "/guilds/" + url.PathEscape(guildID)
	if err := c.proxy(ctx, proxyRequest{ConnectedAccountID: connectedAccountID, Endpoint: endpoint, Method: http.MethodGet}, &wire, "get Discord guild"); err != nil {
		var remote *remoteError
		if errors.As(err, &remote) && (remote.status == http.StatusForbidden || remote.status == http.StatusNotFound) {
			return DiscordIdentity{}, ErrDiscordGuildNotAccessible
		}
		return DiscordIdentity{}, err
	}
	if wire.ID != guildID || strings.TrimSpace(wire.Name) == "" {
		return DiscordIdentity{}, errors.New("Discord guild response was incomplete")
	}
	return DiscordIdentity{GuildID: wire.ID, GuildName: wire.Name}, nil
}

func (c *Client) ListDiscordChannels(ctx context.Context, connectedAccountID, guildID string) ([]DiscordChannel, error) {
	var wire []struct {
		ID       string `json:"id"`
		GuildID  string `json:"guild_id"`
		ParentID string `json:"parent_id"`
		Name     string `json:"name"`
		Type     int    `json:"type"`
	}
	endpoint := "/guilds/" + url.PathEscape(guildID) + "/channels"
	if err := c.proxy(ctx, proxyRequest{ConnectedAccountID: connectedAccountID, Endpoint: endpoint, Method: http.MethodGet}, &wire, "list Discord guild channels"); err != nil {
		return nil, err
	}
	channels := make([]DiscordChannel, 0, len(wire))
	for _, item := range wire {
		if item.ID == "" || item.GuildID != guildID || strings.TrimSpace(item.Name) == "" {
			return nil, errors.New("Discord channel response was incomplete")
		}
		if item.Type == 0 || item.Type == 5 || item.Type == 15 || item.Type == 16 {
			channels = append(channels, DiscordChannel{ID: item.ID, GuildID: item.GuildID, ParentID: item.ParentID, Name: item.Name, Type: item.Type})
		}
	}
	return channels, nil
}

func (c *Client) ListDiscordActiveThreads(ctx context.Context, connectedAccountID, guildID string) ([]DiscordChannel, error) {
	var wire struct {
		Threads []discordThreadWire `json:"threads"`
	}
	endpoint := "/guilds/" + url.PathEscape(guildID) + "/threads/active"
	if err := c.proxy(ctx, proxyRequest{ConnectedAccountID: connectedAccountID, Endpoint: endpoint, Method: http.MethodGet}, &wire, "list active Discord threads"); err != nil {
		return nil, err
	}
	return normalizeDiscordThreads(guildID, wire.Threads)
}

func (c *Client) ListDiscordArchivedThreads(ctx context.Context, connectedAccountID, guildID, channelID, cursor string, limit int) (DiscordThreadPage, error) {
	if guildID == "" || channelID == "" || limit < 1 || limit > 100 {
		return DiscordThreadPage{}, errors.New("invalid Discord archived thread request")
	}
	parameters := []proxyParameter{{Name: "limit", Value: strconv.Itoa(limit), Type: "query"}}
	if cursor != "" {
		parameters = append(parameters, proxyParameter{Name: "before", Value: cursor, Type: "query"})
	}
	var wire struct {
		Threads []discordThreadWire `json:"threads"`
		HasMore bool                `json:"has_more"`
	}
	endpoint := "/channels/" + url.PathEscape(channelID) + "/threads/archived/public"
	if err := c.proxy(ctx, proxyRequest{ConnectedAccountID: connectedAccountID, Endpoint: endpoint, Method: http.MethodGet, Parameters: parameters}, &wire, "list archived Discord threads"); err != nil {
		return DiscordThreadPage{}, err
	}
	threads, err := normalizeDiscordThreads(guildID, wire.Threads)
	if err != nil {
		return DiscordThreadPage{}, err
	}
	for _, thread := range threads {
		if thread.ArchivedAt.IsZero() {
			return DiscordThreadPage{}, errors.New("Discord archived thread timestamp was missing")
		}
	}
	page := DiscordThreadPage{Threads: threads}
	if wire.HasMore {
		if len(wire.Threads) == 0 || wire.Threads[len(wire.Threads)-1].ThreadMetadata.ArchiveTimestamp == "" {
			return DiscordThreadPage{}, errors.New("Discord archived thread cursor was missing")
		}
		page.NextCursor = wire.Threads[len(wire.Threads)-1].ThreadMetadata.ArchiveTimestamp
	}
	return page, nil
}

type discordThreadWire struct {
	ID             string `json:"id"`
	GuildID        string `json:"guild_id"`
	ParentID       string `json:"parent_id"`
	Name           string `json:"name"`
	Type           int    `json:"type"`
	ThreadMetadata struct {
		ArchiveTimestamp string `json:"archive_timestamp"`
	} `json:"thread_metadata"`
}

func normalizeDiscordThreads(guildID string, wire []discordThreadWire) ([]DiscordChannel, error) {
	threads := make([]DiscordChannel, 0, len(wire))
	for _, item := range wire {
		if item.ID == "" || item.GuildID != guildID || item.ParentID == "" || strings.TrimSpace(item.Name) == "" || item.Type < 10 || item.Type > 12 {
			return nil, errors.New("Discord thread response was incomplete")
		}
		var archivedAt time.Time
		if item.ThreadMetadata.ArchiveTimestamp != "" {
			var err error
			archivedAt, err = time.Parse(time.RFC3339Nano, item.ThreadMetadata.ArchiveTimestamp)
			if err != nil {
				return nil, errors.New("Discord archived thread timestamp was invalid")
			}
			archivedAt = archivedAt.UTC()
		}
		threads = append(threads, DiscordChannel{ID: item.ID, GuildID: item.GuildID, ParentID: item.ParentID, Name: item.Name, Type: item.Type, ArchivedAt: archivedAt})
	}
	return threads, nil
}

func (c *Client) ListDiscordMessages(ctx context.Context, connectedAccountID, channelID, before string, limit int) (DiscordMessagePage, error) {
	if channelID == "" || limit < 1 || limit > 100 {
		return DiscordMessagePage{}, errors.New("invalid Discord message page request")
	}
	parameters := []proxyParameter{{Name: "limit", Value: strconv.Itoa(limit), Type: "query"}}
	if before != "" {
		parameters = append(parameters, proxyParameter{Name: "before", Value: before, Type: "query"})
	}
	var wire []struct {
		ID              string `json:"id"`
		ChannelID       string `json:"channel_id"`
		Content         string `json:"content"`
		Timestamp       string `json:"timestamp"`
		EditedTimestamp string `json:"edited_timestamp"`
		Type            int    `json:"type"`
		Author          struct {
			ID         string `json:"id"`
			Username   string `json:"username"`
			GlobalName string `json:"global_name"`
			Bot        bool   `json:"bot"`
		} `json:"author"`
		Member struct {
			Nick string `json:"nick"`
		} `json:"member"`
		Attachments []struct {
			ID       string `json:"id"`
			Filename string `json:"filename"`
			URL      string `json:"url"`
		} `json:"attachments"`
	}
	endpoint := "/channels/" + url.PathEscape(channelID) + "/messages"
	if err := c.proxy(ctx, proxyRequest{ConnectedAccountID: connectedAccountID, Endpoint: endpoint, Method: http.MethodGet, Parameters: parameters}, &wire, "list Discord messages"); err != nil {
		return DiscordMessagePage{}, err
	}
	page := DiscordMessagePage{}
	for _, item := range wire {
		timestamp, err := time.Parse(time.RFC3339Nano, item.Timestamp)
		if err != nil || item.ID == "" || item.ChannelID != channelID || item.Author.ID == "" {
			return DiscordMessagePage{}, errors.New("Discord message response was incomplete")
		}
		authorName := item.Member.Nick
		if strings.TrimSpace(authorName) == "" {
			authorName = item.Author.GlobalName
		}
		if strings.TrimSpace(authorName) == "" {
			authorName = item.Author.Username
		}
		message := DiscordMessage{ID: item.ID, ChannelID: item.ChannelID, Content: item.Content, AuthorID: item.Author.ID, AuthorName: authorName, AuthorBot: item.Author.Bot, Timestamp: timestamp.UTC(), Type: item.Type}
		if item.EditedTimestamp != "" {
			edited, parseErr := time.Parse(time.RFC3339Nano, item.EditedTimestamp)
			if parseErr != nil {
				return DiscordMessagePage{}, errors.New("Discord edited timestamp was invalid")
			}
			message.EditedTimestamp = edited.UTC()
		}
		for _, attachment := range item.Attachments {
			message.Attachments = append(message.Attachments, DiscordAttachment{ID: attachment.ID, Filename: attachment.Filename, URL: attachment.URL})
		}
		page.Messages = append(page.Messages, message)
	}
	if len(wire) == limit && len(wire) > 0 {
		page.NextBefore = wire[len(wire)-1].ID
	}
	return page, nil
}

func RenderDiscordDocumentsWithLimits(identity DiscordIdentity, channels map[string]DiscordChannel, messages []DiscordMessage, limits AppImportLimits) ([]AppDocument, error) {
	type groupKey struct{ channelID, day string }
	grouped := map[groupKey][]DiscordMessage{}
	for _, message := range messages {
		parentID := message.ParentChannelID
		if parentID == "" {
			parentID = message.ChannelID
		}
		if channels[parentID].ID == "" || message.ID == "" || message.Timestamp.IsZero() {
			return nil, errors.New("Discord message did not match a selected channel")
		}
		if strings.TrimSpace(message.Content) == "" && len(message.Attachments) == 0 {
			continue
		}
		day := message.Timestamp.UTC().Format("2006-01-02")
		grouped[groupKey{channelID: parentID, day: day}] = append(grouped[groupKey{channelID: parentID, day: day}], message)
	}
	keys := make([]groupKey, 0, len(grouped))
	for key := range grouped {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].channelID+keys[i].day < keys[j].channelID+keys[j].day })
	documents := make([]AppDocument, 0, len(keys))
	renderedTotal := 0
	for _, key := range keys {
		channel := channels[key.channelID]
		sort.SliceStable(grouped[key], func(i, j int) bool { return grouped[key][i].Timestamp.Before(grouped[key][j].Timestamp) })
		output := newAppDocumentBuilder(limits, &renderedTotal)
		_, _ = fmt.Fprintf(output, "# Discord #%s - %s\n\n- Guild: %s\n- Channel: %s\n- UTC date: %s\n\n", safeAppText(channel.Name), key.day, safeAppText(identity.GuildName), safeAppText(channel.Name), key.day)
		for _, message := range grouped[key] {
			_, _ = fmt.Fprintf(output, "## Message %s\n\n- Time: %s\n- Author: %s\n- Author ID: %s\n", safeAppText(message.ID), message.Timestamp.UTC().Format(time.RFC3339), safeAppText(message.AuthorName), safeAppText(message.AuthorID))
			_, _ = fmt.Fprintf(output, "- Source: https://discord.com/channels/%s/%s/%s\n", url.PathEscape(identity.GuildID), url.PathEscape(message.ChannelID), url.PathEscape(message.ID))
			if message.AuthorBot {
				_, _ = output.WriteString("- Author type: bot\n")
			}
			if message.ThreadName != "" {
				_, _ = fmt.Fprintf(output, "- Thread: %s\n", safeAppText(message.ThreadName))
			}
			if !message.EditedTimestamp.IsZero() {
				_, _ = fmt.Fprintf(output, "- Edited: %s\n", message.EditedTimestamp.UTC().Format(time.RFC3339))
			}
			if strings.TrimSpace(message.Content) != "" {
				_, _ = fmt.Fprintf(output, "\n%s\n", safeAppText(message.Content))
			}
			for _, attachment := range message.Attachments {
				_, _ = fmt.Fprintf(output, "\n- Attachment: %s (%s)", safeAppText(attachment.Filename), safeAppText(attachment.URL))
			}
			_, _ = output.WriteString("\n\n")
		}
		content, err := output.Content()
		if err != nil {
			return nil, err
		}
		if !utf8.Valid(content) {
			return nil, errors.New("Discord document was not valid UTF-8")
		}
		documents = append(documents, AppDocument{RemoteID: "discord:guild:" + identity.GuildID + ":channel:" + key.channelID + ":" + key.day, Filename: "discord-" + safeAppIdentifier(key.channelID) + "-" + key.day + ".md", Markdown: content})
	}
	return documents, nil
}
