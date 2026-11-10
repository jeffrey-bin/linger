package personalinsight

import "github.com/simplexai-labs/linger/apps/teamhub/internal/emailevidence"

type InsightBasis string

const (
	InsightBasisExplicit InsightBasis = "explicit"
	InsightBasisReported InsightBasis = "reported"
	InsightBasisInferred InsightBasis = "inferred"
)

type EvidenceAuthorship string

const (
	EvidenceAuthorshipSelf       EvidenceAuthorship = "self"
	EvidenceAuthorshipOtherHuman EvidenceAuthorship = "other_human"
	EvidenceAuthorshipAutomated  EvidenceAuthorship = "automated"
)

type EvidenceSourceKind string

const (
	EvidenceSourceGmailMessage EvidenceSourceKind = "gmail_message"
)

type EvidenceReference struct {
	EvidenceID    string                     `json:"evidence_id"`
	DatasetID     string                     `json:"dataset_id"`
	SubjectID     string                     `json:"subject_id"`
	Provider      string                     `json:"provider"`
	SourceKind    EvidenceSourceKind         `json:"source_kind"`
	ThreadID      string                     `json:"thread_id,omitempty"`
	MessageID     string                     `json:"message_id,omitempty"`
	Timestamp     string                     `json:"timestamp,omitempty"`
	EmailClass    emailevidence.MessageClass `json:"email_class,omitempty"`
	AuthorID      string                     `json:"author_id,omitempty"`
	ContentSHA256 string                     `json:"content_sha256"`
	Excerpt       string                     `json:"excerpt"`
}

type GroundingEvidence struct {
	Source     EvidenceReference      `json:"source"`
	Strength   emailevidence.Strength `json:"strength"`
	Authorship EvidenceAuthorship     `json:"authorship"`
	ContextID  string                 `json:"context_id"`
	Content    string                 `json:"content"`
}

type InsightDraft struct {
	Dimension   string       `json:"dimension"`
	Basis       InsightBasis `json:"basis"`
	Statement   string       `json:"statement"`
	EvidenceIDs []string     `json:"evidence_ids"`
}

type InsightEvidence struct {
	Source     EvidenceReference      `json:"source"`
	Strength   emailevidence.Strength `json:"strength"`
	Authorship EvidenceAuthorship     `json:"authorship"`
}

// EmailInsight is one Insight validated against the email evidence it cites.
type EmailInsight struct {
	ID        string            `json:"id"`
	Dimension string            `json:"dimension"`
	Basis     InsightBasis      `json:"basis"`
	Statement string            `json:"statement"`
	Evidence  []InsightEvidence `json:"evidence"`
}

type Rejection struct {
	Index int    `json:"index"`
	Code  string `json:"code"`
}

type GenerationResult struct {
	Insights   []EmailInsight `json:"insights"`
	Rejections []Rejection    `json:"rejections,omitempty"`
	// Model is the gateway model that answered; empty when none was called.
	Model string `json:"model,omitempty"`
}
