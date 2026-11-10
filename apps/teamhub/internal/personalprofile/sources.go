package personalprofile

import (
	"strings"
	"unicode/utf8"
)

func ValidateCreateSources(sources []SourceInput) error {
	if len(sources) == 0 || len(sources) > MaxSources {
		return ErrInvalid
	}
	seen := make(map[string]struct{}, len(sources))
	files := 0
	externalAISummaries := 0
	for _, source := range sources {
		switch strings.TrimSpace(source.Kind) {
		case "input_version":
			files++
			if files > MaxFiles {
				return ErrInvalid
			}
			versionID := strings.TrimSpace(source.InputVersionID)
			if versionID == "" || extraSourceFields(source, "input_version") || len(source.Selections) > 0 {
				return ErrInvalid
			}
			if _, exists := seen["input_version:"+versionID]; exists {
				return ErrInvalid
			}
			seen["input_version:"+versionID] = struct{}{}
		case "connection":
			connectionID := strings.TrimSpace(source.ConnectionID)
			if connectionID == "" || extraSourceFields(source, "connection") {
				return ErrInvalid
			}
			if _, exists := seen["connection:"+connectionID]; exists {
				return ErrInvalid
			}
			seen["connection:"+connectionID] = struct{}{}
		case "external_ai_summary":
			externalAISummaries++
			summary := strings.TrimSpace(source.ExternalAISummary)
			if externalAISummaries > 1 || summary == "" || !utf8.ValidString(summary) || strings.ContainsRune(summary, '\x00') || len(summary) > MaxExternalAISummaryBytes || extraSourceFields(source, "external_ai_summary") || len(source.Selections) > 0 {
				return ErrInvalid
			}
		default:
			return ErrInvalid
		}
	}
	return nil
}

func extraSourceFields(source SourceInput, kind string) bool {
	switch kind {
	case "input_version":
		return source.ConnectionID != "" || source.ExternalAISummary != ""
	case "connection":
		return source.InputVersionID != "" || source.ExternalAISummary != ""
	case "external_ai_summary":
		return source.InputVersionID != "" || source.ConnectionID != ""
	default:
		return true
	}
}

func supportedConnectionProvider(provider string) bool {
	switch provider {
	case "gmail", "outlook", "slack", "discord", "github", "google_calendar", "notion":
		return true
	default:
		return false
	}
}

func validConnectionSelections(provider string, selections []Selection) bool {
	if provider == "gmail" || provider == "outlook" {
		return len(selections) == 0
	}
	if provider == "github" && len(selections) == 0 {
		return true
	}
	limits := map[string]int{"slack": 5, "discord": 20, "google_calendar": 10, "github": 5, "notion": 10}
	limit, supported := limits[provider]
	if !supported || len(selections) == 0 || len(selections) > limit {
		return false
	}
	seen := make(map[string]struct{}, len(selections))
	for _, selection := range selections {
		if selection.RemoteID == "" || selection.Name == "" || !validSelectionKind(provider, selection.Kind) || provider == "github" && selection.IsPrivate {
			return false
		}
		if _, duplicate := seen[selection.RemoteID]; duplicate {
			return false
		}
		seen[selection.RemoteID] = struct{}{}
	}
	return true
}

func validSelectionKind(provider, kind string) bool {
	switch provider {
	case "slack":
		return kind == "public_channel" || kind == "private_channel"
	case "discord":
		return kind == "text_channel" || kind == "announcement_channel" || kind == "forum_channel" || kind == "media_channel"
	case "google_calendar":
		return kind == "google_calendar"
	case "github":
		return kind == "github_repository"
	case "notion":
		return kind == "notion_page" || kind == "notion_database"
	default:
		return false
	}
}
