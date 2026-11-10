package document

import (
	"errors"
	"strings"
	"testing"
)

func TestCommentValidationUsesUnicodeCharacterLimits(t *testing.T) {
	input := CreateThreadInput{
		AccountID: "account_1", DocumentID: "document_1", Anchor: &AnchorInput{
			QuotedText:    strings.Repeat("€", 10000),
			BlockID:       strings.Repeat("✓", 255),
			ContextBefore: strings.Repeat("→", 2000),
			ContextAfter:  strings.Repeat("←", 2000),
		},
		Segments: []Segment{{Type: "text", Content: strings.Repeat("€", 50000)}},
	}
	if _, _, err := validateCreateInput(input); err != nil {
		t.Fatalf("valid Unicode character limits: %v", err)
	}

	input.Anchor.QuotedText += "€"
	if _, _, err := validateCreateInput(input); !errors.Is(err, ErrCommentInvalidInput) {
		t.Fatalf("quoted text above character limit error=%v", err)
	}
	input.Anchor.QuotedText = "quote"
	input.Segments = append(input.Segments, Segment{Type: "text", Content: "€"})
	if _, _, err := validateCreateInput(input); !errors.Is(err, ErrCommentInvalidInput) {
		t.Fatalf("combined body above character limit error=%v", err)
	}
}
