package emailevidence

import "strings"

type Strength string

const (
	StrengthPrimary    Strength = "primary"
	StrengthSupporting Strength = "supporting"
	StrengthWeak       Strength = "weak"
)

type WeightedEvidence struct {
	Message  ClassifiedMessage `json:"message"`
	Strength Strength          `json:"strength"`
}

// InsightEvidence weights classified messages as Personal Insight grounding.
// Marketing, drafts, and inbound echoes of the owner's own text carry no
// evidence about the owner.
func InsightEvidence(messages []ClassifiedMessage) []WeightedEvidence {
	echoedInbound := echoedDirectInboundEvidence(messages)
	var result []WeightedEvidence
	for _, message := range messages {
		if message.Body == "" {
			continue
		}
		switch message.Class {
		case MessageClassSelfSent:
			result = appendWeighted(result, message, StrengthPrimary)
		case MessageClassDirectInbound:
			if !echoedInbound[message.Evidence.EvidenceID] {
				result = appendWeighted(result, message, StrengthSupporting)
			}
		case MessageClassSystemNotification:
			result = appendWeighted(result, message, StrengthSupporting)
		case MessageClassSubscription:
			result = appendWeighted(result, message, StrengthWeak)
		}
	}
	return result
}

func echoedDirectInboundEvidence(messages []ClassifiedMessage) map[string]bool {
	selfBodiesByThread := make(map[string]map[string]struct{})
	echoed := make(map[string]bool)
	for _, message := range messages {
		body := canonicalBody(message.Body)
		if body == "" {
			continue
		}
		switch message.Class {
		case MessageClassSelfSent:
			if selfBodiesByThread[message.ThreadID] == nil {
				selfBodiesByThread[message.ThreadID] = make(map[string]struct{})
			}
			selfBodiesByThread[message.ThreadID][body] = struct{}{}
		case MessageClassDirectInbound:
			_, echoed[message.Evidence.EvidenceID] = selfBodiesByThread[message.ThreadID][body]
		}
	}
	return echoed
}

// canonicalBody compares authored bodies, which arrive with quotes removed.
func canonicalBody(body string) string {
	return strings.ToLower(strings.Join(strings.Fields(body), " "))
}

func appendWeighted(destination []WeightedEvidence, message ClassifiedMessage, strength Strength) []WeightedEvidence {
	return append(destination, WeightedEvidence{Message: message, Strength: strength})
}
