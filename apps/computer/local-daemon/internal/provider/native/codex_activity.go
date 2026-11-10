package native

import (
	"bytes"
	"encoding/json"
)

// codexCommandActivity classifies a started commandExecution from Codex's
// parsed commandActions. A command made only of reads is a read, one made
// only of searches or listings is a search; anything else is a command. The
// read path and search query join input for the Room activity line.
func codexCommandActivity(rawActions json.RawMessage, input map[string]any) string {
	var actions []json.RawMessage
	if json.Unmarshal(rawActions, &actions) != nil || len(actions) == 0 {
		return ActivityCommand
	}
	kind := ""
	for _, raw := range actions {
		var action map[string]any
		if json.Unmarshal(raw, &action) != nil || action == nil {
			return ActivityCommand
		}
		var next string
		switch action["type"] {
		case "read":
			next = ActivityRead
			codexAddInput(input, "path", action["path"])
		case "search", "listFiles":
			next = ActivitySearch
			codexAddInput(input, "query", action["query"])
			codexAddInput(input, "path", action["path"])
		default:
			return ActivityCommand
		}
		if kind != "" && next != kind {
			return ActivityCommand
		}
		kind = next
	}
	return kind
}

// codexWebSearchInput builds the input and kind of a webSearch item. Opening
// or searching inside a page is browsing; everything else is a search.
func codexWebSearchInput(item *codexItem) (map[string]any, string) {
	input := map[string]any{}
	codexAddInput(input, "query", codexJSONString(item.Query))
	var action map[string]any
	_ = json.Unmarshal(item.Action, &action)
	switch action["type"] {
	case "openPage", "findInPage":
		codexAddInput(input, "url", action["url"])
		return input, ActivityBrowse
	case "search":
		codexAddInput(input, "query", action["query"])
	}
	return input, ActivitySearch
}

// codexAddInput sets key to a non-empty string value unless key is set.
func codexAddInput(input map[string]any, key string, value any) {
	text, ok := value.(string)
	if !ok || text == "" {
		return
	}
	if _, set := input[key]; !set {
		input[key] = text
	}
}

// codexJSONString is raw as a string, or empty when it is not one.
func codexJSONString(raw json.RawMessage) string {
	var text string
	if len(bytes.TrimSpace(raw)) == 0 || json.Unmarshal(raw, &text) != nil {
		return ""
	}
	return text
}
