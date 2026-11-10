// Package memoryclient is TeamHub's one client for Memory, the Node Services
// role: the Web proxies, the River update after a Wiki publication and the
// Agent knowledge bridge share it. Each call sets its own deadline.
package memoryclient

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

const (
	// Web reads answer within a page load.
	proxyTimeout = 10 * time.Second
	// Memory indexes the published Wiki before it answers.
	updateTimeout = 15 * time.Minute
	// Memory asks the model a few times before Tracking Items follow a Pocket Note.
	pocketNoteTrackingTimeout = 5 * time.Minute
	// Memory asks the model once to fold a published Profile into memory.md.
	profileMemoryTimeout = 5 * time.Minute
	// An Agent knowledge query; its JSON answer is read up to 4 MiB.
	knowledgeTimeout       = 120 * time.Second
	knowledgeResponseLimit = 4 << 20
)

var ErrVisualizationNotFound = errors.New("personal knowledge graph visualization not found")
var ErrMemoryEntryNotFound = errors.New("personal memory entry not found")

// MemoryEntry is one Personal Memory entry as Memory returns it.
type MemoryEntry = nodeservicesinternal.MemoryEntry

// MemoryEntryPage is one page of Personal Memory entries.
type MemoryEntryPage = nodeservicesinternal.MemoryEntryPage

type Client struct {
	api *nodeservicesinternal.ClientWithResponses
}

func New(baseURL, token string) (*Client, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("Memory base URL must be an HTTP(S) origin")
	}
	if token == "" || len(token) > 4096 || strings.ContainsAny(token, " \t\r\n,") {
		return nil, errors.New("Memory service token is invalid")
	}
	api, err := nodeservicesinternal.NewClientWithResponses(
		strings.TrimRight(baseURL, "/"),
		// The service token never follows a redirect.
		nodeservicesinternal.WithHTTPClient(&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}}),
		nodeservicesinternal.WithRequestEditorFn(func(_ context.Context, request *http.Request) error {
			request.Header.Set("Accept", "application/json")
			request.Header.Set("Authorization", "Bearer "+token)
			return nil
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("create Memory client: %w", err)
	}
	return &Client{api: api}, nil
}

// UpdatePublishedWiki hands Memory a published Wiki revision to index. It is
// idempotent.
func (c *Client) UpdatePublishedWiki(ctx context.Context, tenantID, ownerID, revisionID string) error {
	ctx, cancel := context.WithTimeout(ctx, updateTimeout)
	defer cancel()
	response, err := c.api.UpdateGraphForPublishedWikiWithResponse(ctx, nodeservicesinternal.PublishedWikiGraphUpdateRequest{
		OwnerActorId: ownerID, WikiRevisionId: revisionID, TenantId: tenantID,
	})
	if err != nil {
		return fmt.Errorf("send published Wiki update: %w", err)
	}
	if response.StatusCode() != http.StatusNoContent {
		return fmt.Errorf("Memory published Wiki update returned HTTP %d", response.StatusCode())
	}
	return nil
}

// RefreshPocketNoteTracking has Memory update the Human's Tracking Items from
// one Pocket Note day as it is now. It is idempotent.
func (c *Client) RefreshPocketNoteTracking(ctx context.Context, tenantID, ownerActorID, date string) error {
	day, err := time.Parse(time.DateOnly, date)
	if err != nil {
		return fmt.Errorf("parse Pocket Note day: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, pocketNoteTrackingTimeout)
	defer cancel()
	response, err := c.api.RefreshPocketNoteTrackingItemsWithResponse(ctx, nodeservicesinternal.PocketNoteTrackingRefreshRequest{
		TenantId: tenantID, OwnerActorId: ownerActorID, Date: openapi_types.Date{Time: day},
	})
	if err != nil {
		return fmt.Errorf("send Pocket Note tracking refresh: %w", err)
	}
	if response.StatusCode() != http.StatusNoContent {
		return fmt.Errorf("Memory Pocket Note tracking refresh returned HTTP %d", response.StatusCode())
	}
	return nil
}

// SyncProfileMemory has Memory fold the Human's current Profile into memory.md.
func (c *Client) SyncProfileMemory(ctx context.Context, tenantID, ownerActorID string) error {
	ctx, cancel := context.WithTimeout(ctx, profileMemoryTimeout)
	defer cancel()
	response, err := c.api.SyncProfileMemoryWithResponse(ctx, nodeservicesinternal.ProfileMemorySyncRequest{
		TenantId: tenantID, OwnerActorId: ownerActorID,
	})
	if err != nil {
		return fmt.Errorf("send Profile memory sync: %w", err)
	}
	if response.StatusCode() != http.StatusNoContent {
		return fmt.Errorf("Memory Profile memory sync returned HTTP %d", response.StatusCode())
	}
	return nil
}

func (c *Client) GetPersonalKnowledgeGraphVisualization(
	ctx context.Context,
	tenantID string,
	ownerActorID string,
) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, proxyTimeout)
	defer cancel()
	response, err := c.api.GetPersonalKnowledgeGraphVisualizationWithResponse(
		ctx,
		nodeservicesinternal.PersonalKnowledgeGraphVisualizationRequest{
			OwnerActorId: ownerActorID,
			TenantId:     tenantID,
		},
		func(_ context.Context, request *http.Request) error {
			request.Header.Set("Accept", "text/html")
			return nil
		},
	)
	if err != nil {
		return nil, fmt.Errorf("read personal knowledge graph visualization: %w", err)
	}
	switch response.StatusCode() {
	case http.StatusOK:
		return response.Body, nil
	case http.StatusNotFound:
		return nil, ErrVisualizationNotFound
	default:
		return nil, fmt.Errorf("Memory graph visualization returned HTTP %d", response.StatusCode())
	}
}

func (c *Client) ListPersonalMemoryEntries(
	ctx context.Context,
	tenantID string,
	ownerActorID string,
	kind, cursor *string,
	limit *int,
) (MemoryEntryPage, error) {
	params := &nodeservicesinternal.ListMemoryEntriesParams{
		TenantId:     tenantID,
		OwnerActorId: ownerActorID,
	}
	if kind != nil {
		params.Kind = kind
	}
	if cursor != nil {
		params.Cursor = cursor
	}
	if limit != nil {
		params.Limit = limit
	}
	ctx, cancel := context.WithTimeout(ctx, proxyTimeout)
	defer cancel()
	response, err := c.api.ListMemoryEntriesWithResponse(ctx, params)
	if err != nil {
		return MemoryEntryPage{}, fmt.Errorf("list personal Memory entries: %w", err)
	}
	switch response.StatusCode() {
	case http.StatusOK:
		if response.JSON200 == nil {
			return MemoryEntryPage{}, errors.New("Memory entry list response was empty")
		}
		return *response.JSON200, nil
	case http.StatusNotFound:
		return MemoryEntryPage{}, ErrMemoryEntryNotFound
	default:
		return MemoryEntryPage{}, fmt.Errorf("Memory entry list returned HTTP %d", response.StatusCode())
	}
}

func (c *Client) GetPersonalMemoryEntry(
	ctx context.Context,
	tenantID string,
	ownerActorID string,
	entryID string,
) (MemoryEntry, error) {
	params := &nodeservicesinternal.GetMemoryEntryParams{
		TenantId:     tenantID,
		OwnerActorId: ownerActorID,
	}
	ctx, cancel := context.WithTimeout(ctx, proxyTimeout)
	defer cancel()
	response, err := c.api.GetMemoryEntryWithResponse(ctx, entryID, params)
	if err != nil {
		return MemoryEntry{}, fmt.Errorf("get personal Memory entry: %w", err)
	}
	switch response.StatusCode() {
	case http.StatusOK:
		if response.JSON200 == nil {
			return MemoryEntry{}, errors.New("Memory entry response was empty")
		}
		return *response.JSON200, nil
	case http.StatusNotFound:
		return MemoryEntry{}, ErrMemoryEntryNotFound
	default:
		return MemoryEntry{}, fmt.Errorf("Memory entry returned HTTP %d", response.StatusCode())
	}
}

// Knowledge forwards one Agent knowledge request that TeamHub has already
// scoped, and returns Memory's status and JSON body. A body over 4 MiB is an
// error rather than a truncated answer.
func (c *Client) Knowledge(ctx context.Context, tool string, body []byte) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, knowledgeTimeout)
	defer cancel()
	send := map[string]func(context.Context, string, io.Reader, ...nodeservicesinternal.RequestEditorFn) (*http.Response, error){
		"search_knowledge": c.api.QueryPersonalKnowledgeWithBody,
		"read_knowledge":   c.api.ReadPersonalKnowledgeEvidenceWithBody,
	}[tool]
	if send == nil {
		return 0, nil, fmt.Errorf("unknown knowledge tool %q", tool)
	}
	response, err := send(ctx, "application/json", bytes.NewReader(body))
	if err != nil {
		return 0, nil, fmt.Errorf("query Memory knowledge: %w", err)
	}
	defer response.Body.Close()
	result, err := io.ReadAll(io.LimitReader(response.Body, knowledgeResponseLimit+1))
	if err != nil {
		return 0, nil, fmt.Errorf("read Memory knowledge: %w", err)
	}
	if len(result) > knowledgeResponseLimit {
		return 0, nil, errors.New("Memory knowledge response exceeds 4 MiB")
	}
	return response.StatusCode, result, nil
}
