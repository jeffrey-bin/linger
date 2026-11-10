package personalprofile

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const (
	pdfMediaType  = "application/pdf"
	docxMediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)

func SniffAndExtract(filename, mediaType string, body []byte) (string, error) {
	if len(body) == 0 || int64(len(body)) > MaxFileBytes || !utf8.Valid(body) && !isPDF(body) && !isZIP(body) {
		return "", ErrInvalid
	}
	kind, err := sniffKind(filename, mediaType, body)
	if err != nil {
		return "", err
	}
	switch kind {
	case "txt", "md":
		if bytes.Contains(body, []byte{0}) || looksLikeHTML(body) {
			return "", ErrInvalid
		}
		return truncateExtracted(string(body)), nil
	case "docx":
		text, err := extractDOCX(body)
		if err != nil {
			return "", ErrInvalid
		}
		return truncateExtracted(text), nil
	case "pdf":
		text, err := extractPDF(body)
		if err != nil {
			return "", ErrInvalid
		}
		return truncateExtracted(text), nil
	default:
		return "", ErrInvalid
	}
}

func sniffKind(filename, mediaType string, body []byte) (string, error) {
	extension := strings.ToLower(filepath.Ext(filename))
	normalized := normalizeMediaType(mediaType)
	switch {
	case extension == ".pdf" && normalized == pdfMediaType && isPDF(body):
		return "pdf", nil
	case extension == ".docx" && normalized == docxMediaType && isDOCX(body):
		return "docx", nil
	case extension == ".md" && (normalized == "text/markdown" || normalized == "text/plain") && isText(body):
		return "md", nil
	case extension == ".txt" && normalized == "text/plain" && isText(body):
		return "txt", nil
	default:
		return "", ErrInvalid
	}
}

func normalizeMediaType(value string) string {
	value = strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
	return value
}

func isPDF(body []byte) bool {
	return bytes.HasPrefix(body, []byte("%PDF-"))
}

func isZIP(body []byte) bool {
	return bytes.HasPrefix(body, []byte("PK\x03\x04")) || bytes.HasPrefix(body, []byte("PK\x05\x06"))
}

func isDOCX(body []byte) bool {
	if !isZIP(body) {
		return false
	}
	reader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return false
	}
	hasTypes, hasDocument := false, false
	for _, file := range reader.File {
		switch file.Name {
		case "[Content_Types].xml":
			hasTypes = true
		case "word/document.xml":
			hasDocument = true
		}
	}
	return hasTypes && hasDocument
}

func isText(body []byte) bool {
	return utf8.Valid(body) && !bytes.Contains(body, []byte{0}) && !isPDF(body) && !isZIP(body)
}

func looksLikeHTML(body []byte) bool {
	lower := bytes.ToLower(bytes.TrimSpace(body))
	return bytes.Contains(lower, []byte("<script")) || bytes.HasPrefix(lower, []byte("<!doctype html")) || bytes.HasPrefix(lower, []byte("<html"))
}

func extractDOCX(body []byte) (string, error) {
	reader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return "", err
	}
	var document io.ReadCloser
	for _, file := range reader.File {
		if file.Name != "word/document.xml" {
			continue
		}
		if file.UncompressedSize64 > MaxFileBytes {
			return "", ErrInvalid
		}
		document, err = file.Open()
		if err != nil {
			return "", err
		}
		break
	}
	if document == nil {
		return "", ErrInvalid
	}
	defer document.Close()
	limited, err := io.ReadAll(io.LimitReader(document, MaxFileBytes+1))
	if err != nil || int64(len(limited)) > MaxFileBytes {
		return "", ErrInvalid
	}
	return strings.TrimSpace(docxText(limited)), nil
}

func docxText(body []byte) string {
	decoder := xml.NewDecoder(bytes.NewReader(body))
	var parts []string
	for {
		token, err := decoder.Token()
		if err != nil {
			break
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "t" {
			continue
		}
		var text string
		if err = decoder.DecodeElement(&text, &start); err == nil && strings.TrimSpace(text) != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, " ")
}

func truncateExtracted(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= MaxExtractedBytes {
		return value
	}
	return value[:MaxExtractedBytes]
}
