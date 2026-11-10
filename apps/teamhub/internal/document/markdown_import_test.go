package document

import (
	"bytes"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

const embeddedPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII="

func TestNativeMarkdownImportExtractsImagesAndPreservesCode(t *testing.T) {
	uri := "data:image/png;base64," + embeddedPNG
	source := []byte("# Report\n\n![first](" + uri + ")\n\n![second][same]\n\n[same]: " + uri + "\n\n`![example](" + uri + ")`\n\n```md\n![code](" + uri + ")\n```\n")
	prepared, err := PrepareImport(source)
	if err != nil {
		t.Fatal(err)
	}
	if len(prepared.Assets) != 1 {
		t.Fatalf("unique images=%d", len(prepared.Assets))
	}
	decoded, _ := base64.StdEncoding.DecodeString(embeddedPNG)
	if !bytes.Equal(prepared.Assets[0].Contents, decoded) {
		t.Fatal("image bytes changed")
	}
	rendered, err := prepared.Rewrite(map[string]string{prepared.Assets[0].Key: "document_asset_test"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(rendered), "document-asset:document_asset_test") != 2 {
		t.Fatalf("missing image references: %.300s", rendered)
	}
	if strings.Count(string(rendered), uri) != 2 {
		t.Fatal("code examples were interpreted as images")
	}
}
func TestNativeMarkdownImportRejectsInvalidImages(t *testing.T) {
	for _, uri := range []string{
		"data:image/png;base64,broken!", "data:image/png;base64,aGVsbG8=",
		"data:image/svg+xml;base64,PHN2Zy8+", "data:text/html;base64,PGgxLz4=",
		"data:image/jpeg;base64," + embeddedPNG,
	} {
		t.Run(uri[:min(len(uri), 40)], func(t *testing.T) {
			_, err := PrepareImport([]byte("![image](" + uri + ")"))
			if !errors.Is(err, ErrInvalidMarkdown) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestNativeMarkdownImportRewritesRepeatedImagesInTable(t *testing.T) {
	uri := "data:image/png;base64," + embeddedPNG
	prepared, err := PrepareImport([]byte("| A | B |\n| --- | --- |\n| ![first](" + uri + ") | ![again](" + uri + ") |\n"))
	if err != nil {
		t.Fatal(err)
	}
	rendered, err := prepared.Rewrite(map[string]string{prepared.Assets[0].Key: "document_asset_table"})
	if err != nil {
		t.Fatal(err)
	}
	want := "| A | B |\n| --- | --- |\n| ![first](document-asset:document_asset_table) | ![again](document-asset:document_asset_table) |\n"
	if len(prepared.Assets) != 1 || string(rendered) != want {
		t.Fatalf("assets=%d rewritten=%s", len(prepared.Assets), rendered)
	}
}

func TestNativeMarkdownImportRejectsDataMediaInRawHTML(t *testing.T) {
	uri := "data:image/png;base64," + embeddedPNG
	for name, source := range map[string]string{
		"block":  "<p><img src=\"" + uri + "\"></p>\n",
		"inline": "Text <img alt=x src='" + uri + "'> more\n",
		// An unquoted HTML attribute value cannot contain "=".
		"unquoted":         "<img src=" + strings.TrimSuffix(uri, "=") + ">\n",
		"with data images": "![image](" + uri + ")\n\n<img src=\"" + uri + "\">\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := PrepareImport([]byte(source)); !errors.Is(err, ErrInvalidMarkdown) {
				t.Fatalf("error=%v", err)
			}
		})
	}
	for name, source := range map[string]string{
		"code span":  "`<img src=\"" + uri + "\">`\n",
		"code block": "```html\n<img src=\"" + uri + "\">\n```\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := PrepareImport([]byte(source)); err != nil {
				t.Fatalf("code example rejected: %v", err)
			}
		})
	}
}
