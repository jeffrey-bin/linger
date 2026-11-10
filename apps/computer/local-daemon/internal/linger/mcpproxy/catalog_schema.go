package mcpproxy

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// This file mirrors how Codex 0.155.1 (rmcp 3.2.0, serde) decodes a tools/list
// response, so readiness is never reported for a catalog Codex would drop.
// encoding/json is not used for typed decoding here: it matches keys
// case-insensitively and accepts duplicates, while serde matches exact keys,
// ignores unknown ones, and rejects a duplicated struct field.

type serdeFields map[string]json.RawMessage

// decodeSerdeStruct returns the exact keys of one JSON object, or false when
// the value is not an object or repeats a key.
func decodeSerdeStruct(raw json.RawMessage) (serdeFields, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, false
	}
	fields := serdeFields{}
	for decoder.More() {
		token, err := decoder.Token()
		key, isKey := token.(string)
		if err != nil || !isKey {
			return nil, false
		}
		if _, duplicate := fields[key]; duplicate {
			return nil, false
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return nil, false
		}
		fields[key] = value
	}
	token, err := decoder.Token()
	return fields, err == nil && token == json.Delim('}')
}

func jsonKind(value json.RawMessage) byte {
	value = bytes.TrimSpace(value)
	if len(value) == 0 {
		return 0
	}
	return value[0]
}

func isJSONNull(value json.RawMessage) bool { return string(bytes.TrimSpace(value)) == "null" }

func isJSONString(value json.RawMessage) bool { return jsonKind(value) == '"' }

func jsonString(value json.RawMessage) (string, bool) {
	var text string
	return text, isJSONString(value) && json.Unmarshal(value, &text) == nil
}

func jsonArray(value json.RawMessage) ([]json.RawMessage, bool) {
	var items []json.RawMessage
	return items, jsonKind(value) == '[' && json.Unmarshal(value, &items) == nil
}

// optional applies check to a present, non-null field; serde decodes a missing
// or null Option as None.
func (f serdeFields) optional(key string, check func(json.RawMessage) bool) bool {
	value, present := f[key]
	return !present || isJSONNull(value) || check(value)
}

func (f serdeFields) required(key string, check func(json.RawMessage) bool) bool {
	value, present := f[key]
	return present && !isJSONNull(value) && check(value)
}

func isJSONObject(value json.RawMessage) bool { return jsonKind(value) == '{' }

func isJSONBool(value json.RawMessage) bool {
	text := string(bytes.TrimSpace(value))
	return text == "true" || text == "false"
}

func isJSONInt64(value json.RawMessage) bool {
	_, err := strconv.ParseInt(string(bytes.TrimSpace(value)), 10, 64)
	return err == nil
}

func isJSONStringIn(allowed ...string) func(json.RawMessage) bool {
	return func(value json.RawMessage) bool {
		text, ok := jsonString(value)
		if !ok {
			return false
		}
		for _, candidate := range allowed {
			if text == candidate {
				return true
			}
		}
		return false
	}
}

func isJSONArrayOf(item func(json.RawMessage) bool) func(json.RawMessage) bool {
	return func(value json.RawMessage) bool {
		items, ok := jsonArray(value)
		if !ok {
			return false
		}
		for _, element := range items {
			if isJSONNull(element) || !item(element) {
				return false
			}
		}
		return true
	}
}

func isSerdeStruct(check func(serdeFields) bool) func(json.RawMessage) bool {
	return func(value json.RawMessage) bool {
		fields, ok := decodeSerdeStruct(value)
		return ok && check(fields)
	}
}

// installableToolCatalog mirrors rmcp 3.2.0 ListToolsResult.
func installableToolCatalog(result json.RawMessage) bool {
	return isSerdeStruct(func(f serdeFields) bool {
		return f.required("tools", isJSONArrayOf(isSerdeStruct(installableTool))) &&
			f.optional("nextCursor", isJSONString) &&
			f.optional("resultType", isJSONString) &&
			f.optional("_meta", isJSONObject) &&
			f.optional("ttlMs", isJSONInt64) &&
			f.optional("cacheScope", isJSONStringIn("public", "private"))
	})(result)
}

// installableTool mirrors rmcp 3.2.0 Tool.
func installableTool(f serdeFields) bool {
	name, _ := jsonString(f["name"])
	return f.required("name", isJSONString) && strings.TrimSpace(name) != "" &&
		f.optional("title", isJSONString) &&
		f.optional("description", isJSONString) &&
		f.required("inputSchema", isJSONObject) &&
		f.optional("outputSchema", isJSONObject) &&
		f.optional("annotations", isSerdeStruct(func(a serdeFields) bool {
			return a.optional("title", isJSONString) &&
				a.optional("readOnlyHint", isJSONBool) &&
				a.optional("destructiveHint", isJSONBool) &&
				a.optional("idempotentHint", isJSONBool) &&
				a.optional("openWorldHint", isJSONBool)
		})) &&
		f.optional("icons", isJSONArrayOf(isSerdeStruct(func(icon serdeFields) bool {
			return icon.required("src", isJSONString) &&
				icon.optional("mimeType", isJSONString) &&
				icon.optional("sizes", isJSONArrayOf(isJSONString)) &&
				icon.optional("theme", isJSONStringIn("light", "dark"))
		}))) &&
		f.optional("_meta", isJSONObject)
}
