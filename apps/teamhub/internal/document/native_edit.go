package document

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// Native edit actions are frozen by admission before Runtime resolves their
// text and ranges against the same immutable Document state.
func validateNativeEditOperation(value json.RawMessage) error {
	var edit struct {
		Kind          string  `json:"kind"`
		ParserVersion string  `json:"parser_version"`
		Command       string  `json:"command"`
		Content       *string `json:"content,omitempty"`
		Pattern       *string `json:"pattern,omitempty"`
		BlockID       *string `json:"block_id,omitempty"`
		StartBlockID  *string `json:"start_block_id,omitempty"`
		EndBlockID    *string `json:"end_block_id,omitempty"`
		Title         *string `json:"title,omitempty"`
		AssetID       *string `json:"asset_id,omitempty"`
		Caption       *string `json:"caption,omitempty"`
		Name          *string `json:"name,omitempty"`
	}
	if decodeStrictSemanticOperation(value, &edit) != nil || edit.ParserVersion != "markdown-v1" {
		return ErrInvalidInput
	}
	allowed := map[string][]string{
		"append": {"content"}, "str_replace": {"content", "pattern", "block_id"},
		"block_insert_before": {"content", "block_id"}, "block_insert_after": {"content", "block_id"},
		"block_replace": {"content", "block_id", "start_block_id", "end_block_id"},
		"block_delete":  {"block_id", "start_block_id", "end_block_id"}, "set_title": {"title"},
		"image_insert_after": {"block_id", "asset_id", "caption"}, "image_replace": {"block_id", "asset_id", "caption"},
		"file_insert_after": {"block_id", "asset_id", "name"},
	}
	fields, ok := allowed[edit.Command]
	if !ok {
		return ErrInvalidInput
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(value, &raw) != nil {
		return ErrInvalidInput
	}
	for key := range raw {
		if key == "kind" || key == "parser_version" || key == "command" {
			continue
		}
		found := false
		for _, candidate := range fields {
			if candidate == key {
				found = true
			}
		}
		if !found || string(raw[key]) == "null" {
			return ErrInvalidInput
		}
	}
	for _, id := range []*string{edit.BlockID, edit.StartBlockID, edit.EndBlockID} {
		if id != nil && (len(*id) > 64 || *id == "0" || !semanticBlockIDPattern.MatchString(*id)) {
			return ErrInvalidInput
		}
	}
	switch edit.Command {
	case "set_title":
		if edit.Title == nil || utf8.RuneCountInString(*edit.Title) < 1 || utf8.RuneCountInString(*edit.Title) > 255 {
			return ErrInvalidInput
		}
	case "str_replace":
		if edit.Content == nil || edit.Pattern == nil || *edit.Pattern == "" || strings.ContainsAny(*edit.Pattern, "\r\n") || strings.ContainsAny(*edit.Content, "\r\n") {
			return ErrInvalidInput
		}
	case "block_delete":
	case "image_insert_after", "image_replace", "file_insert_after":
		if edit.BlockID == nil || edit.AssetID == nil || len(*edit.AssetID) > 64 || *edit.AssetID == "0" ||
			!semanticBlockIDPattern.MatchString(*edit.AssetID) ||
			edit.Caption != nil && (utf8.RuneCountInString(*edit.Caption) > 1000 || strings.ContainsAny(*edit.Caption, "\r\n")) ||
			edit.Name != nil && (*edit.Name == "" || utf8.RuneCountInString(*edit.Name) > 255 || strings.ContainsAny(*edit.Name, "\r\n")) {
			return ErrInvalidInput
		}
	default:
		if edit.Content == nil || strings.TrimSpace(*edit.Content) == "" {
			return ErrInvalidInput
		}
	}
	if (edit.Command == "block_insert_before" || edit.Command == "block_insert_after") && edit.BlockID == nil {
		return ErrInvalidInput
	}
	if edit.Command == "block_replace" || edit.Command == "block_delete" {
		if edit.BlockID != nil {
			if edit.StartBlockID != nil || edit.EndBlockID != nil {
				return ErrInvalidInput
			}
		} else if edit.StartBlockID == nil || edit.EndBlockID == nil {
			return ErrInvalidInput
		}
	}
	return nil
}

// nativeEditAsset returns the Asset an image or file edit places, if any, and
// whether that edit needs an image.
func nativeEditAsset(value json.RawMessage) (assetID string, image bool) {
	var edit struct {
		Command string `json:"command"`
		AssetID string `json:"asset_id"`
	}
	if json.Unmarshal(value, &edit) != nil {
		return "", false
	}
	switch edit.Command {
	case "image_insert_after", "image_replace":
		return edit.AssetID, true
	case "file_insert_after":
		return edit.AssetID, false
	}
	return "", false
}
