package documenttext

import (
	"bytes"
	"strings"

	"github.com/ledongthuc/pdf"
)

// LongestLineBytes is the UTF-8 size of the longest line of the Markdown. A
// text over one Wiki source budget enters the Wiki only when no line is over
// it, so it can be cut at line breaks into pieces within the budget. The
// migration that filled in the existing texts splits at every \n the same
// way.
func LongestLineBytes(markdown string) int64 {
	longest := 0
	for len(markdown) > 0 {
		line, rest, _ := strings.Cut(markdown, "\n")
		longest = max(longest, len(line))
		markdown = rest
	}
	return int64(longest)
}

// scannedPDF reports a PDF without a text layer: no page draws any text, so
// the normalizer read its Markdown by OCR alone and the Wiki leaves it out.
// A file that is not a PDF, or one this reader cannot parse, counts as having
// a text layer; the normalizer has already read it.
func scannedPDF(source []byte) (scanned bool) {
	if !bytes.Contains(source[:min(len(source), 1024)], []byte("%PDF-")) {
		return false
	}
	defer func() {
		if recover() != nil {
			scanned = false
		}
	}()
	reader, err := pdf.NewReader(bytes.NewReader(source), int64(len(source)))
	if err != nil || reader.NumPage() < 1 {
		return false
	}
	for number := 1; number <= reader.NumPage(); number++ {
		if page := reader.Page(number); !page.V.IsNull() && len(page.Content().Text) > 0 {
			return false
		}
	}
	return true
}
