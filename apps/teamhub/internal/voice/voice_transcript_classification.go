package voice

import (
	"strings"
)

// NormalizeCaptureTranscript classifies a Capture transcript before it is stored.
func NormalizeCaptureTranscript(text string) string {
	return strings.Trim(strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\t', '\n', '\r', '。', '！', '？', '，', ',', '.', '!', '?', '：', ':':
			return -1
		default:
			return r
		}
	}, text), " ")
}
