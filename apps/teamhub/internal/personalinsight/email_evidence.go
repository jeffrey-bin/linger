package personalinsight

import (
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/emailevidence"
)

func EmailGroundingEvidence(sourceSubjectID string, evidence []emailevidence.WeightedEvidence) []GroundingEvidence {
	sourceSubjectID = normalizeSubjectID(sourceSubjectID)
	grounding := make([]GroundingEvidence, 0, len(evidence))
	for _, item := range evidence {
		if strings.TrimSpace(item.Message.Body) == "" || !validInsightClassStrength(item.Message.Class, item.Strength) {
			continue
		}
		authorship := EvidenceAuthorshipAutomated
		authorID := ""
		switch item.Message.Class {
		case emailevidence.MessageClassSelfSent:
			authorship = EvidenceAuthorshipSelf
			authorID = "self"
		case emailevidence.MessageClassDirectInbound:
			authorship = EvidenceAuthorshipOtherHuman
			authorID = strings.ToLower(strings.TrimSpace(item.Message.SenderLocal))
		}
		grounding = append(grounding, GroundingEvidence{
			Source: EvidenceReference{
				EvidenceID: item.Message.Evidence.EvidenceID, DatasetID: item.Message.Evidence.DatasetID, SubjectID: sourceSubjectID,
				Provider: "gmail", SourceKind: EvidenceSourceGmailMessage,
				ThreadID: item.Message.Evidence.ThreadID, MessageID: item.Message.Evidence.MessageID,
				Timestamp: item.Message.Evidence.Timestamp, EmailClass: item.Message.Evidence.Class,
				AuthorID: authorID, ContentSHA256: item.Message.Evidence.BodySHA256,
				Excerpt: item.Message.Evidence.Excerpt,
			},
			Strength: item.Strength, Authorship: authorship,
			ContextID: "gmail:" + item.Message.ThreadID, Content: item.Message.Body,
		})
	}
	return grounding
}

func normalizeSubjectID(subjectID string) string {
	return strings.ToLower(strings.TrimSpace(subjectID))
}
