package documenttext

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
)

func TestLongestLineBytesCountsUTF8BytesPerLine(t *testing.T) {
	for markdown, want := range map[string]int64{
		"":                         0,
		"one line":                 8,
		"# One\nbody":              5,
		"a\n\nlonger line\nb\n":    11,
		"trailing\n":               8,
		"x\r\nyy":                  2,
		"caf\u00e9\nx":             5,
		"\U0001F600\U0001F600\nab": 8,
	} {
		if got := LongestLineBytes(markdown); got != want {
			t.Errorf("LongestLineBytes(%q)=%d, want %d", markdown, got, want)
		}
	}
}

// pdfFile assembles a one-page PDF with a correct cross-reference table.
func pdfFile(page, content string, extra ...string) []byte {
	objects := append([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		page,
		fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content),
	}, extra...)
	var file bytes.Buffer
	file.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects))
	for index, object := range objects {
		offsets[index] = file.Len()
		fmt.Fprintf(&file, "%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	start := file.Len()
	fmt.Fprintf(&file, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for _, offset := range offsets {
		fmt.Fprintf(&file, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&file, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, start)
	return file.Bytes()
}

func TestScannedPDFIsOnlyAPDFWithoutATextLayer(t *testing.T) {
	text := pdfFile("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		"BT /F1 12 Tf 20 100 Td (Quarterly plan) Tj ET",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	scan := pdfFile("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
		"q 200 0 0 200 0 0 cm /Im0 Do Q",
		"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\xff\nendstream")
	for name, test := range map[string]struct {
		source []byte
		want   bool
	}{
		"text layer":      {text, false},
		"scan":            {scan, true},
		"markdown":        {[]byte("# Notes\n\nPlain text."), false},
		"broken PDF":      {[]byte("%PDF-1.4\nnot really a PDF"), false},
		"truncated scan":  {scan[:len(scan)/2], false},
		"empty":           {nil, false},
		"PDF magic later": {append([]byte(strings.Repeat(" ", 2000)), scan...), false},
	} {
		if got := scannedPDF(test.source); got != test.want {
			t.Errorf("%s: scannedPDF=%v, want %v", name, got, test.want)
		}
	}
}
