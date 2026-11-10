package document

import (
	"context"
	"encoding/json"
)

// Runtime is the Document Runtime as the Document service calls it. Import
// and Export compute over the state TeamHub sends and keep nothing; Apply
// changes a Document's online body, which the Runtime saves.
// A Service without a Runtime reports ErrRuntimeUnavailable for these
// operations.
type Runtime interface {
	Import(context.Context, ImportRequest) (ImportedState, error)
	Export(context.Context, ExportRuntimeRequest) (ExportRuntimeResult, error)
	Apply(context.Context, ApplyRequest) (ApplyResult, error)
}

// Import source kinds. A text source may place AllowedAssetIDs; a
// document_state source is an existing state remapped by AssetMappings.
const (
	importBlank         = "blank"
	importMarkdown      = "markdown"
	importDocumentState = "document_state"
)

// ImportRequest computes the initial state of a new native Document.
// OperationID is a UUID for text sources; it seeds the state deterministically.
type ImportRequest struct {
	OperationID, SourceKind string
	SourceBytes             []byte
	AllowedAssetIDs         []string
	AssetMappings           []DuplicateAssetMapping
}

// ImportedState is a computed initial state with its references.
type ImportedState struct {
	StateBytes, StateVector                []byte
	StateBytesSHA256, FullStateFingerprint string
	StateHashVersion                       int
	CompleteAssetIDs, CompleteThreadIDs    []string
}

// DuplicateAssetMapping renames a source asset reference in a duplicated state.
type DuplicateAssetMapping struct {
	SourceAssetID, TargetAssetID string
}

// ApplyRequest is one authorized server change to a Document's body. Exactly
// one of Semantic, Restore and CommentAnchor is set. ExpectedSeq, when set,
// limits the change to the body at that sequence.
type ApplyRequest struct {
	DocumentID, OperationID, ActorID string
	ExpectedSeq                      *int64
	Semantic                         *SemanticChange
	Restore                          *RestoreChange
	CommentAnchor                    *CommentAnchorChange
}

// SemanticChange is a batch of semantic operations an Agent asked for.
type SemanticChange struct {
	SchemaVersion, CurrentTitle string
	AllowedAssetIDs             []string
	Operations                  json.RawMessage
}

// RestoreChange replaces the body with a History Revision's state.
type RestoreChange struct {
	TargetStateBytes []byte
}

// CommentAnchorChange marks a pending Comment Thread's selection in the body.
type CommentAnchorChange struct {
	ThreadID, QuotedText, BlockID, ContextBefore, ContextAfter string
}

// ApplyResult reports the saved body sequence, or a conflict that changed
// nothing.
type ApplyResult struct {
	Applied                             bool
	ConflictReason                      string
	Seq                                 int64
	StateHash, Title                    string
	CompleteAssetIDs, CompleteThreadIDs []string
}
