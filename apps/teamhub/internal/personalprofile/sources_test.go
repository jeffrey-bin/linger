package personalprofile

import (
	"errors"
	"strings"
	"testing"

	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

func TestValidateCreateSourcesAcceptsMixedInputAndConnection(t *testing.T) {
	if err := ValidateCreateSources([]SourceInput{
		{Kind: "input_version", InputVersionID: "wiki_version_1"},
		{Kind: "connection", ConnectionID: "external_connection_1"},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestValidateCreateSourcesAcceptsInputVersions(t *testing.T) {
	if err := ValidateCreateSources([]SourceInput{
		{Kind: "input_version", InputVersionID: "wiki_version_1"},
		{Kind: "input_version", InputVersionID: "wiki_version_2"},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestValidateCreateSourcesAcceptsOneExternalAISummary(t *testing.T) {
	if err := ValidateCreateSources([]SourceInput{
		{Kind: "external_ai_summary", ExternalAISummary: "  I prefer concise written plans.  "},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestValidateCreateSourcesRejectsInvalidExternalAISummary(t *testing.T) {
	for name, sources := range map[string][]SourceInput{
		"blank": {
			{Kind: "external_ai_summary", ExternalAISummary: " \n\t "},
		},
		"duplicate": {
			{Kind: "external_ai_summary", ExternalAISummary: "First"},
			{Kind: "external_ai_summary", ExternalAISummary: "Second"},
		},
		"mixed fields": {
			{Kind: "external_ai_summary", ExternalAISummary: "Summary", ConnectionID: "external_connection_1"},
		},
		"too large": {
			{Kind: "external_ai_summary", ExternalAISummary: strings.Repeat("x", MaxExternalAISummaryBytes+1)},
		},
		"nul byte": {
			{Kind: "external_ai_summary", ExternalAISummary: "Before\x00after"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := ValidateCreateSources(sources); !errors.Is(err, ErrInvalid) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestValidateCreateSourcesRejectsInvalidInputVersions(t *testing.T) {
	if err := ValidateCreateSources([]SourceInput{
		{Kind: "input_version", InputVersionID: "wiki_version_1", ConnectionID: "external_connection_1"},
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("mixed source fields: %v", err)
	}
	if err := ValidateCreateSources([]SourceInput{
		{Kind: "file", InputVersionID: "wiki_version_1"},
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("retired file kind: %v", err)
	}
	if err := ValidateCreateSources([]SourceInput{
		{Kind: "input_version"},
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("missing version: %v", err)
	}
	if err := ValidateCreateSources([]SourceInput{
		{Kind: "input_version", InputVersionID: "wiki_version_1"},
		{Kind: "input_version", InputVersionID: "wiki_version_1"},
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate version: %v", err)
	}
	sources := make([]SourceInput, MaxFiles+1)
	for i := range sources {
		sources[i] = SourceInput{Kind: "input_version", InputVersionID: idgen.New("wiki_version")}
	}
	if err := ValidateCreateSources(sources); !errors.Is(err, ErrInvalid) {
		t.Fatalf("too many input versions: %v", err)
	}
}

func TestValidateCreateSourcesRejectsEmptyOrTooMany(t *testing.T) {
	if err := ValidateCreateSources(nil); err == nil {
		t.Fatal("expected invalid empty sources")
	}
	sources := make([]SourceInput, MaxSources+1)
	for i := range sources {
		sources[i] = SourceInput{Kind: "connection", ConnectionID: idgen.New("external_connection")}
	}
	if err := ValidateCreateSources(sources); err == nil {
		t.Fatal("expected too many sources")
	}
}

func TestValidateCreateSourcesRejectsDuplicateConnections(t *testing.T) {
	err := ValidateCreateSources([]SourceInput{
		{Kind: "connection", ConnectionID: "external_connection_1"},
		{Kind: "connection", ConnectionID: "external_connection_1"},
	})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("got %v", err)
	}
}
