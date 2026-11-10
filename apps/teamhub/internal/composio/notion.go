package composio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

const notionAPIVersion = "2022-06-28"

type NotionIdentity struct {
	BotID, WorkspaceName string
}

type NotionResource struct {
	ID, Title, Kind, URL string
}

type NotionResourcePage struct {
	Resources  []NotionResource
	NextCursor string
}

type NotionSnapshot struct {
	Resource NotionResource
	Title    string
	Markdown string
}

func (c *Client) IdentifyNotion(ctx context.Context, connectedAccountID string) (NotionIdentity, error) {
	var wire struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		Bot  struct {
			WorkspaceName string `json:"workspace_name"`
		} `json:"bot"`
	}
	if err := c.notionProxy(ctx, connectedAccountID, "/v1/users/me", http.MethodGet, nil, nil, &wire, "identify Notion account"); err != nil {
		return NotionIdentity{}, err
	}
	if strings.TrimSpace(wire.ID) == "" {
		return NotionIdentity{}, errors.New("Notion identity response was incomplete")
	}
	name := strings.TrimSpace(wire.Bot.WorkspaceName)
	if name == "" {
		name = "Notion"
	}
	return NotionIdentity{BotID: strings.TrimSpace(wire.ID), WorkspaceName: name}, nil
}

func (c *Client) ListNotionResources(ctx context.Context, connectedAccountID, cursor string, limit int) (NotionResourcePage, error) {
	if limit < 1 || limit > 100 {
		return NotionResourcePage{}, errors.New("invalid Notion resource page request")
	}
	body := map[string]any{"page_size": limit, "sort": map[string]string{"direction": "descending", "timestamp": "last_edited_time"}}
	if strings.TrimSpace(cursor) != "" {
		body["start_cursor"] = cursor
	}
	var wire struct {
		Results    []json.RawMessage `json:"results"`
		NextCursor string            `json:"next_cursor"`
		HasMore    bool              `json:"has_more"`
	}
	if err := c.notionProxy(ctx, connectedAccountID, "/v1/search", http.MethodPost, nil, body, &wire, "list Notion resources"); err != nil {
		return NotionResourcePage{}, err
	}
	page := NotionResourcePage{}
	for _, raw := range wire.Results {
		resource, ok := parseNotionResource(raw)
		if !ok {
			continue
		}
		page.Resources = append(page.Resources, resource)
	}
	if wire.HasMore {
		page.NextCursor = strings.TrimSpace(wire.NextCursor)
	}
	return page, nil
}

func (c *Client) GetNotionPage(ctx context.Context, connectedAccountID string, resource NotionResource) (NotionSnapshot, error) {
	if resource.ID == "" || resource.Kind != "notion_page" {
		return NotionSnapshot{}, errors.New("invalid Notion page")
	}
	markdown, err := c.notionBlockMarkdown(ctx, connectedAccountID, resource.ID, 0)
	if err != nil {
		return NotionSnapshot{}, err
	}
	title := strings.TrimSpace(resource.Title)
	if title == "" {
		title = "Untitled"
	}
	return NotionSnapshot{Resource: resource, Title: title, Markdown: markdown}, nil
}

func (c *Client) GetNotionDatabase(ctx context.Context, connectedAccountID string, resource NotionResource) (NotionSnapshot, error) {
	if resource.ID == "" || resource.Kind != "notion_database" {
		return NotionSnapshot{}, errors.New("invalid Notion database")
	}
	type row struct {
		ID         string                     `json:"id"`
		Properties map[string]json.RawMessage `json:"properties"`
	}
	rows := make([]row, 0, 100)
	cursor := ""
	for len(rows) < 100 {
		remaining := 100 - len(rows)
		if remaining > 50 {
			remaining = 50
		}
		body := map[string]any{"page_size": remaining}
		if cursor != "" {
			body["start_cursor"] = cursor
		}
		var wire struct {
			Results    []row  `json:"results"`
			NextCursor string `json:"next_cursor"`
			HasMore    bool   `json:"has_more"`
		}
		if err := c.notionProxy(ctx, connectedAccountID, "/v1/databases/"+resource.ID+"/query", http.MethodPost, nil, body, &wire, "query Notion database"); err != nil {
			return NotionSnapshot{}, err
		}
		rows = append(rows, wire.Results...)
		if !wire.HasMore || strings.TrimSpace(wire.NextCursor) == "" || wire.NextCursor == cursor {
			break
		}
		cursor = wire.NextCursor
	}
	var builder strings.Builder
	for _, item := range rows {
		values := notionPropertyValues(item.Properties)
		if len(values) == 0 {
			continue
		}
		builder.WriteString("- ")
		builder.WriteString(strings.Join(values, " · "))
		builder.WriteString("\n")
	}
	title := strings.TrimSpace(resource.Title)
	if title == "" {
		title = "Untitled"
	}
	return NotionSnapshot{Resource: resource, Title: title, Markdown: builder.String()}, nil
}

func RenderNotionDocumentsWithLimits(identity NotionIdentity, snapshots []NotionSnapshot, limits AppImportLimits) ([]AppDocument, error) {
	if identity.BotID == "" || len(snapshots) == 0 || len(snapshots) > 10 {
		return nil, errors.New("invalid Notion snapshot")
	}
	limits = NormalizeAppImportLimits(limits)
	renderedTotal := 0
	documents := make([]AppDocument, 0, len(snapshots))
	seen := map[string]bool{}
	for _, snapshot := range snapshots {
		resource := snapshot.Resource
		if resource.ID == "" || seen[resource.ID] || resource.Kind != "notion_page" && resource.Kind != "notion_database" {
			return nil, errors.New("invalid Notion resource snapshot")
		}
		seen[resource.ID] = true
		title := strings.TrimSpace(snapshot.Title)
		if title == "" {
			title = strings.TrimSpace(resource.Title)
		}
		if title == "" {
			title = "Untitled"
		}
		output := newAppDocumentBuilder(limits, &renderedTotal)
		_, _ = fmt.Fprintf(output, "# %s\n\n- Workspace: %s\n- Notion ID: %s\n- Canonical URL: %s\n- Provenance: %s\n\n", safeAppText(title), safeAppText(identity.WorkspaceName), safeAppText(resource.ID), safeAppText(resource.URL), resource.Kind)
		_, _ = output.WriteString(snapshot.Markdown)
		if !strings.HasSuffix(snapshot.Markdown, "\n") {
			_, _ = output.WriteString("\n")
		}
		content, err := output.Content()
		if err != nil {
			return nil, err
		}
		kind := "page"
		if resource.Kind == "notion_database" {
			kind = "database"
		}
		documents = append(documents, AppDocument{
			RemoteID: "notion:" + kind + ":" + resource.ID,
			Filename: boundedAppFilename("notion-"+kind, title, resource.ID, "snapshot"),
			Markdown: content,
		})
	}
	return documents, nil
}

func (c *Client) notionBlockMarkdown(ctx context.Context, connectedAccountID, blockID string, depth int) (string, error) {
	if depth > 3 {
		return "", nil
	}
	var builder strings.Builder
	cursor := ""
	for page := 0; page < 5; page++ {
		parameters := []proxyParameter{{Name: "page_size", Value: "50", Type: "query"}}
		if cursor != "" {
			parameters = append(parameters, proxyParameter{Name: "start_cursor", Value: cursor, Type: "query"})
		}
		var wire struct {
			Results    []notionBlock `json:"results"`
			NextCursor string        `json:"next_cursor"`
			HasMore    bool          `json:"has_more"`
		}
		if err := c.notionProxy(ctx, connectedAccountID, "/v1/blocks/"+blockID+"/children", http.MethodGet, parameters, nil, &wire, "read Notion page"); err != nil {
			return "", err
		}
		for _, block := range wire.Results {
			if block.Type == "child_page" || block.Type == "child_database" {
				continue
			}
			if line := notionBlockLine(block); line != "" {
				builder.WriteString(line)
				if !strings.HasSuffix(line, "\n") {
					builder.WriteString("\n")
				}
			}
			if block.HasChildren {
				child, err := c.notionBlockMarkdown(ctx, connectedAccountID, block.ID, depth+1)
				if err != nil {
					return "", err
				}
				builder.WriteString(child)
			}
		}
		if !wire.HasMore || strings.TrimSpace(wire.NextCursor) == "" || wire.NextCursor == cursor {
			break
		}
		cursor = wire.NextCursor
	}
	return builder.String(), nil
}

type notionBlock struct {
	ID          string          `json:"id"`
	Type        string          `json:"type"`
	HasChildren bool            `json:"has_children"`
	Paragraph   notionRichText  `json:"paragraph"`
	Heading1    notionRichText  `json:"heading_1"`
	Heading2    notionRichText  `json:"heading_2"`
	Heading3    notionRichText  `json:"heading_3"`
	Bulleted    notionRichText  `json:"bulleted_list_item"`
	Numbered    notionRichText  `json:"numbered_list_item"`
	ToDo        notionRichText  `json:"to_do"`
	Quote       notionRichText  `json:"quote"`
	Callout     notionRichText  `json:"callout"`
	Code        notionRichText  `json:"code"`
	Raw         json.RawMessage `json:"-"`
}

type notionRichText struct {
	RichText []struct {
		PlainText string `json:"plain_text"`
	} `json:"rich_text"`
}

func notionBlockLine(block notionBlock) string {
	switch block.Type {
	case "heading_1":
		return "# " + notionRichPlain(block.Heading1)
	case "heading_2":
		return "## " + notionRichPlain(block.Heading2)
	case "heading_3":
		return "### " + notionRichPlain(block.Heading3)
	case "bulleted_list_item":
		return "- " + notionRichPlain(block.Bulleted)
	case "numbered_list_item":
		return "1. " + notionRichPlain(block.Numbered)
	case "to_do":
		return "- [ ] " + notionRichPlain(block.ToDo)
	case "quote":
		return "> " + notionRichPlain(block.Quote)
	case "callout":
		return notionRichPlain(block.Callout)
	case "code":
		return "```\n" + notionRichPlain(block.Code) + "\n```"
	case "divider":
		return "---"
	case "paragraph":
		return notionRichPlain(block.Paragraph)
	default:
		return ""
	}
}

func notionRichPlain(value notionRichText) string {
	parts := make([]string, 0, len(value.RichText))
	for _, item := range value.RichText {
		if text := strings.TrimSpace(item.PlainText); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, " ")
}

func parseNotionResource(raw json.RawMessage) (NotionResource, bool) {
	var header struct {
		Object string `json:"object"`
		ID     string `json:"id"`
		URL    string `json:"url"`
		Title  []struct {
			PlainText string `json:"plain_text"`
		} `json:"title"`
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(raw, &header); err != nil || strings.TrimSpace(header.ID) == "" {
		return NotionResource{}, false
	}
	var kind string
	switch header.Object {
	case "page":
		kind = "notion_page"
	case "database":
		kind = "notion_database"
	default:
		return NotionResource{}, false
	}
	title := strings.TrimSpace(joinPlainText(header.Title))
	if title == "" {
		title = firstNotionTitle(header.Properties)
	}
	if title == "" {
		title = "Untitled"
	}
	return NotionResource{ID: strings.TrimSpace(header.ID), Title: title, Kind: kind, URL: strings.TrimSpace(header.URL)}, true
}

func firstNotionTitle(properties map[string]json.RawMessage) string {
	for _, raw := range properties {
		var property struct {
			Type  string `json:"type"`
			Title []struct {
				PlainText string `json:"plain_text"`
			} `json:"title"`
		}
		if json.Unmarshal(raw, &property) != nil || property.Type != "title" {
			continue
		}
		if title := strings.TrimSpace(joinPlainText(property.Title)); title != "" {
			return title
		}
	}
	return ""
}

func notionPropertyValues(properties map[string]json.RawMessage) []string {
	values := make([]string, 0, len(properties))
	for name, raw := range properties {
		text := notionPropertyPlain(raw)
		if text == "" {
			continue
		}
		label := strings.TrimSpace(name)
		if label == "" {
			values = append(values, text)
			continue
		}
		values = append(values, label+": "+text)
	}
	return values
}

func notionPropertyPlain(raw json.RawMessage) string {
	var property struct {
		Type  string `json:"type"`
		Title []struct {
			PlainText string `json:"plain_text"`
		} `json:"title"`
		RichText []struct {
			PlainText string `json:"plain_text"`
		} `json:"rich_text"`
		Select *struct {
			Name string `json:"name"`
		} `json:"select"`
		URL      string   `json:"url"`
		Email    string   `json:"email"`
		Checkbox bool     `json:"checkbox"`
		Number   *float64 `json:"number"`
	}
	if json.Unmarshal(raw, &property) != nil {
		return ""
	}
	switch property.Type {
	case "title":
		return joinPlainText(property.Title)
	case "rich_text":
		return joinPlainText(property.RichText)
	case "select":
		if property.Select != nil {
			return strings.TrimSpace(property.Select.Name)
		}
	case "url":
		return strings.TrimSpace(property.URL)
	case "email":
		return strings.TrimSpace(property.Email)
	case "checkbox":
		if property.Checkbox {
			return "yes"
		}
		return "no"
	case "number":
		if property.Number != nil {
			return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%f", *property.Number), "0"), ".")
		}
	}
	return ""
}

func joinPlainText(nodes []struct {
	PlainText string `json:"plain_text"`
}) string {
	parts := make([]string, 0, len(nodes))
	for _, node := range nodes {
		if text := strings.TrimSpace(node.PlainText); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, " ")
}

func (c *Client) notionProxy(ctx context.Context, connectedAccountID, endpoint, method string, parameters []proxyParameter, body any, target any, operation string) error {
	encoded, err := encodeNotionBody(body)
	if err != nil {
		return err
	}
	headers := []proxyParameter{{Name: "Notion-Version", Value: notionAPIVersion, Type: "header"}}
	return c.proxy(ctx, proxyRequest{
		ConnectedAccountID: connectedAccountID,
		Endpoint:           endpoint,
		Method:             method,
		Parameters:         append(headers, parameters...),
		Body:               encoded,
	}, target, operation)
}

func encodeNotionBody(body any) (json.RawMessage, error) {
	if body == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}
