package personalinsight

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/emailevidence"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalprofile"
)

// buildEvidence turns the Gmail message inputs of one Profile generation to
// grounded Insight evidence; generationID names the dataset of each message.
func buildEvidence(generationID, ownerActorID string, documents []personalprofile.InsightDocument) ([]GroundingEvidence, error) {
	emailInputs := make([]emailevidence.MessageInput, 0)
	seenMessages := make(map[string]struct{})
	for _, document := range documents {
		if strings.ToLower(strings.TrimSpace(document.Provider)) != "gmail" {
			continue
		}
		var messages []emailevidence.MessageInput
		if err := json.Unmarshal([]byte(document.Content), &messages); err != nil {
			return nil, errors.New("Personal Insight Gmail evidence is invalid")
		}
		for _, message := range messages {
			message.DatasetID = generationID
			key := message.ThreadID + "\n" + message.MessageID
			if _, duplicate := seenMessages[key]; duplicate {
				continue
			}
			seenMessages[key] = struct{}{}
			emailInputs = append(emailInputs, message)
		}
	}
	result := make([]GroundingEvidence, 0)
	if len(emailInputs) > 0 {
		classified, err := emailevidence.Classify(emailInputs)
		if err != nil {
			return nil, err
		}
		result = append(result, EmailGroundingEvidence(ownerActorID, emailevidence.InsightEvidence(classified))...)
	}
	return result, nil
}

func contentFingerprint(dimension, statement string) string {
	canonical := strings.ToLower(strings.Join(strings.Fields(dimension), " ")) + "\n" + strings.ToLower(strings.Join(strings.Fields(statement), " "))
	digest := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(digest[:])
}
