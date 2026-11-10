package personalprofile

import (
	"bytes"
	"strings"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
)

func extractPDF(body []byte) (string, error) {
	reader, err := pdf.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil || reader.NumPage() <= 0 || reader.NumPage() > 50 {
		return "", ErrInvalid
	}
	var builder strings.Builder
	for page := 1; page <= reader.NumPage(); page++ {
		text, pageErr := reader.Page(page).GetPlainText(nil)
		if pageErr != nil {
			return "", ErrInvalid
		}
		builder.WriteString(text)
		if builder.Len() > MaxExtractedBytes {
			break
		}
	}
	value := strings.TrimSpace(builder.String())
	if value == "" || !utf8.ValidString(value) {
		return "", ErrInvalid
	}
	return value, nil
}
