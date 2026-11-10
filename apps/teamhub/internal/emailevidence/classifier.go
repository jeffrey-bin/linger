package emailevidence

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"unicode/utf8"
)

const evidenceExcerptRunes = 280

func Classify(inputs []MessageInput) ([]ClassifiedMessage, error) {
	classified := make([]ClassifiedMessage, 0, len(inputs))
	seen := make(map[string]struct{}, len(inputs))
	for _, input := range inputs {
		input.DatasetID = strings.TrimSpace(input.DatasetID)
		input.ThreadID = strings.TrimSpace(input.ThreadID)
		input.MessageID = strings.TrimSpace(input.MessageID)
		input.Body = strings.TrimSpace(input.Body)
		if input.DatasetID == "" || input.ThreadID == "" || input.MessageID == "" {
			return nil, fmt.Errorf("email evidence identifiers must not be empty")
		}
		if !utf8.ValidString(input.Body) {
			return nil, fmt.Errorf("email evidence body must be valid UTF-8")
		}
		evidenceID := "gmail:" + input.DatasetID + ":" + input.ThreadID + ":" + input.MessageID
		if _, exists := seen[evidenceID]; exists {
			return nil, fmt.Errorf("duplicate email evidence %q", evidenceID)
		}
		seen[evidenceID] = struct{}{}

		class, err := classifyMessage(input)
		if err != nil {
			return nil, err
		}
		digest := sha256.Sum256([]byte(input.Body))
		classified = append(classified, ClassifiedMessage{
			MessageInput: input,
			Class:        class,
			Evidence: EvidenceReference{
				EvidenceID: evidenceID,
				DatasetID:  input.DatasetID,
				ThreadID:   input.ThreadID,
				MessageID:  input.MessageID,
				Timestamp:  strings.TrimSpace(input.Timestamp),
				Class:      class,
				BodySHA256: hex.EncodeToString(digest[:]),
				Excerpt:    truncateRunes(input.Body, evidenceExcerptRunes),
			},
		})
	}
	return classified, nil
}

func classifyMessage(input MessageInput) (MessageClass, error) {
	switch input.Direction {
	case DirectionDraft:
		return MessageClassDraft, nil
	case DirectionOutbound:
		return MessageClassSelfSent, nil
	case DirectionInbound:
		if class := classifyInbound(input); class != "" {
			return class, nil
		}
		return MessageClassDirectInbound, nil
	default:
		return "", fmt.Errorf("unsupported email direction %q", input.Direction)
	}
}

func classifyInbound(input MessageInput) MessageClass {
	return AutomatedClass(input.Signals)
}

// AutomatedClass maps structural signals to an automated class, or "" for
// human mail.
func AutomatedClass(s Signals) MessageClass {
	category := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(s.Category)), "category_")
	switch {
	case s.AutoSubmitted || category == "social" || category == "forums" || category == "updates":
		return MessageClassSystemNotification
	case s.ListID || s.BulkPrecedence:
		return MessageClassSubscription
	case category == "promotions" || s.ListUnsubscribe:
		return MessageClassMarketing
	}
	return ""
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
