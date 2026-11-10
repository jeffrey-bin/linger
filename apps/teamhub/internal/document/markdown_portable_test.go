package document

import (
	"errors"
	"strings"
	"testing"
)

func TestPortableMarkdownRewritesMediaButPreservesExamples(t *testing.T) {
	source := "# Heading\n\n![first](document-asset:asset_one)\n\n> ![second](document-asset:asset_one)\n\nSee [file](document-asset:asset_two).\n\n`![code](document-asset:asset_one)` and ![real](document-asset:asset_one)\n\n```md\n![example](document-asset:asset_one)\n```\n\nEscaped \\[text](document-asset:asset_one)\n"
	got, err := InlineAssets([]byte(source), func(id string) (string, error) { return "data:image/png;base64," + id, nil })
	if err != nil {
		t.Fatal(err)
	}
	output := string(got)
	if strings.Count(output, "data:image/png;base64,asset_one") != 3 || strings.Count(output, "data:image/png;base64,asset_two") != 1 {
		t.Fatalf("wrong media replacements: %s", output)
	}
	for _, example := range []string{"`![code](document-asset:asset_one)`", "```md\n![example](document-asset:asset_one)\n```", "Escaped \\[text](document-asset:asset_one)"} {
		if !strings.Contains(output, example) {
			t.Fatalf("rewrote example %q", example)
		}
	}
}

func TestPortableMarkdownFailsWhenAssetUnavailable(t *testing.T) {
	unavailable := errors.New("Asset unavailable")
	_, err := InlineAssets([]byte("![image](document-asset:missing)"), func(string) (string, error) { return "", unavailable })
	if !errors.Is(err, unavailable) {
		t.Fatalf("err=%v", err)
	}
}

// Downloads parse Markdown with GFM, as imports do: an image in a table cell is
// media, and a code span in a cell stays an example.
func TestPortableMarkdownRewritesMediaInTableCells(t *testing.T) {
	source := "| Image | Example |\n| --- | --- |\n| ![cell](document-asset:asset_one) | `![code](document-asset:asset_one)` |\n"
	got, err := InlineAssets([]byte(source), func(id string) (string, error) { return "data:image/png;base64," + id, nil })
	if err != nil {
		t.Fatal(err)
	}
	output := string(got)
	if strings.Count(output, "data:image/png;base64,asset_one") != 1 || !strings.Contains(output, "`![code](document-asset:asset_one)`") {
		t.Fatalf("wrong table media replacements: %s", output)
	}
}
