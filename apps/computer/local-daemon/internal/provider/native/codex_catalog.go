package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

const (
	codexCatalogPageLimit  = 100
	codexCatalogMaxCursors = 20
)

// discoverCodexProtocolCatalog lists models through app-server model/list.
// It never starts a thread or a turn.
func discoverCodexProtocolCatalog(ctx context.Context, inv Invocation, version string) (ModelList, error) {
	initialize := map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{"clientInfo": map[string]any{"name": "linger-catalog", "version": "1"}, "capabilities": nil},
	}
	var models catalogModels
	expected := int64(1)
	cursors := map[string]bool{}
	page := func(id int64, cursor string) map[string]any {
		params := map[string]any{"limit": codexCatalogPageLimit, "includeHidden": false}
		if cursor != "" {
			params["cursor"] = cursor
		}
		return map[string]any{"jsonrpc": "2.0", "id": id, "method": "model/list", "params": params}
	}
	receive := func(frame []byte, send func(...any) error) (bool, error) {
		message, id, isReply := codexCatalogReplyFrame(frame)
		if !isReply || id != expected {
			return false, nil
		}
		if len(message.Error) > 0 && string(bytes.TrimSpace(message.Error)) != "null" {
			return false, errors.New("Codex catalog RPC was rejected")
		}
		result := bytes.TrimSpace(message.Result)
		if expected == 1 {
			if len(result) == 0 || string(result) == "null" {
				return false, errors.New("Codex catalog initialize returned no result")
			}
			expected++
			return false, send(map[string]any{"jsonrpc": "2.0", "method": "initialized"}, page(expected, ""))
		}
		next, err := codexAddModelPage(&models, result)
		if err != nil {
			return false, err
		}
		if next == "" {
			if len(models.models) == 0 {
				return false, errors.New("Codex model/list returned no selectable models")
			}
			return true, nil
		}
		if cursors[next] || len(cursors) >= codexCatalogMaxCursors {
			return false, errors.New("Codex catalog pagination did not terminate")
		}
		cursors[next] = true
		expected++
		return false, send(page(expected, next))
	}
	if err := exchangeCatalog(ctx, inv, CodexAppServerArgs(version), []any{initialize}, receive); err != nil {
		return ModelList{}, err
	}
	return models.list(), nil
}

type codexCatalogReply struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

// codexCatalogReplyFrame decodes a JSON-RPC reply and its numeric id. It
// reports false for notifications and lines that are not JSON-RPC, which
// the exchange skips.
func codexCatalogReplyFrame(frame []byte) (codexCatalogReply, int64, bool) {
	var message codexCatalogReply
	if json.Unmarshal(frame, &message) != nil {
		return message, 0, false
	}
	id, err := strconv.ParseInt(string(bytes.TrimSpace(message.ID)), 10, 64)
	return message, id, err == nil
}

func codexAddModelPage(models *catalogModels, result json.RawMessage) (string, error) {
	var page struct {
		Data       []json.RawMessage `json:"data"`
		NextCursor *string           `json:"nextCursor"`
	}
	if json.Unmarshal(result, &page) != nil || page.Data == nil {
		return "", errors.New("Codex model/list returned invalid data")
	}
	for _, raw := range page.Data {
		var entry struct {
			ID                        string `json:"id"`
			Model                     string `json:"model"`
			DisplayName               string `json:"displayName"`
			Hidden                    bool   `json:"hidden"`
			IsDefault                 bool   `json:"isDefault"`
			DefaultReasoningEffort    string `json:"defaultReasoningEffort"`
			SupportedReasoningEfforts []struct {
				ReasoningEffort string `json:"reasoningEffort"`
				Description     string `json:"description"`
			} `json:"supportedReasoningEfforts"`
		}
		if json.Unmarshal(raw, &entry) != nil || entry.Hidden {
			continue
		}
		id := entry.Model
		if id == "" {
			id = entry.ID
		}
		var efforts effortCatalog
		for _, effort := range entry.SupportedReasoningEfforts {
			efforts.add(effort.ReasoningEffort, effort.Description)
		}
		models.add(ModelOption{
			ID: id, Label: strings.TrimSpace(entry.DisplayName), Provider: "openai",
			Default: entry.IsDefault, Effort: efforts.support(entry.DefaultReasoningEffort),
		})
	}
	if page.NextCursor == nil {
		return "", nil
	}
	return *page.NextCursor, nil
}
