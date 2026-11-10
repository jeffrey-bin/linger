package emailevidence

type Direction string

const (
	DirectionInbound  Direction = "inbound"
	DirectionOutbound Direction = "outbound"
	DirectionDraft    Direction = "draft"
)

type MessageClass string

const (
	MessageClassSelfSent           MessageClass = "self_sent"
	MessageClassDirectInbound      MessageClass = "direct_inbound"
	MessageClassSystemNotification MessageClass = "system_notification"
	MessageClassSubscription       MessageClass = "subscription"
	MessageClassMarketing          MessageClass = "marketing"
	MessageClassDraft              MessageClass = "draft"
)

// Signals are the header and label facts that mark mail as automated.
type Signals struct {
	Category        string `json:"category"`
	ListID          bool   `json:"list_id"`
	ListUnsubscribe bool   `json:"list_unsubscribe"`
	AutoSubmitted   bool   `json:"auto_submitted"`
	BulkPrecedence  bool   `json:"bulk_precedence"`
}

type MessageInput struct {
	DatasetID string    `json:"dataset_id"`
	ThreadID  string    `json:"thread_id"`
	MessageID string    `json:"message_id"`
	Timestamp string    `json:"timestamp"`
	Direction Direction `json:"direction"`
	Signals
	// SenderLocal attributes authorship only; it never classifies mail.
	SenderLocal string `json:"sender_local"`
	Body        string `json:"body"`
}

type EvidenceReference struct {
	EvidenceID string       `json:"evidence_id"`
	DatasetID  string       `json:"dataset_id"`
	ThreadID   string       `json:"thread_id"`
	MessageID  string       `json:"message_id"`
	Timestamp  string       `json:"timestamp"`
	Class      MessageClass `json:"class"`
	BodySHA256 string       `json:"body_sha256"`
	Excerpt    string       `json:"excerpt"`
}

type ClassifiedMessage struct {
	MessageInput
	Class    MessageClass      `json:"class"`
	Evidence EvidenceReference `json:"evidence"`
}
