package personalprofile

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

func TestSniffFileRejectsMismatchedAndUnsafeTypes(t *testing.T) {
	cases := []struct {
		name, filename, mediaType string
		body                      []byte
	}{
		{"exe as pdf", "resume.pdf", "application/pdf", []byte("MZ\x90\x00")},
		{"zip as docx", "notes.docx", docxMediaType, zipBytes(t, "readme.txt", "hi")},
		{"pdf claimed as txt", "notes.txt", "text/plain", []byte("%PDF-1.7\n")},
		{"html as markdown", "about.md", "text/markdown", []byte("<script>alert(1)</script>")},
	}
	for _, item := range cases {
		if _, err := SniffAndExtract(item.filename, item.mediaType, item.body); err == nil {
			t.Fatalf("%s: accepted unsafe or mismatched file", item.name)
		}
	}
}

func TestSniffFileExtractsTextMarkdownAndDocx(t *testing.T) {
	text, err := SniffAndExtract("bio.txt", "text/plain", []byte("Hello from a resume"))
	if err != nil || !strings.Contains(text, "Hello from a resume") {
		t.Fatalf("txt: %q %v", text, err)
	}
	markdown, err := SniffAndExtract("bio.md", "text/markdown", []byte("# Person\n\nWrites software."))
	if err != nil || !strings.Contains(markdown, "Writes software") {
		t.Fatalf("md: %q %v", markdown, err)
	}
	docx, err := SniffAndExtract("bio.docx", docxMediaType, minimalDOCX(t, "Worked at Linger"))
	if err != nil || !strings.Contains(docx, "Worked at Linger") {
		t.Fatalf("docx: %q %v", docx, err)
	}
}

func zipBytes(t *testing.T, name, body string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	file, err := writer.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = file.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func minimalDOCX(t *testing.T, text string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	types, err := writer.Create("[Content_Types].xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = types.Write([]byte(`<?xml version="1.0"?><Types></Types>`)); err != nil {
		t.Fatal(err)
	}
	document, err := writer.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = document.Write([]byte(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>` + text + `</w:t></w:r></w:p></w:body></w:document>`)); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
