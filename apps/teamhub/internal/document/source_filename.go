package document

import (
	"path"
	"strings"
	"unicode/utf8"
)

// maxSourceFilenameBytes keeps a filename within every limit that receives it:
// 255 UTF-8 bytes are also at most 255 UTF-16 code units for LLM Wiki and at
// most 765 characters once percent-encoded into a normalization header.
const maxSourceFilenameBytes = 255

// SafeSourceFilename returns a stored filename as TeamHub sends it to LLM Wiki
// candidate generation and document normalization, which reject control
// characters and longer names. Control characters become spaces, and a longer
// name is cut at a character boundary, keeping its extension. A name that
// already fits is returned unchanged.
func SafeSourceFilename(filename string) string {
	filename = strings.Map(func(character rune) rune {
		if character <= 0x1f || character == 0x7f {
			return ' '
		}
		return character
	}, filename)
	if len(filename) <= maxSourceFilenameBytes {
		return filename
	}
	extension := path.Ext(filename)
	if len(extension) > 32 {
		extension = ""
	}
	stem := filename[:len(filename)-len(extension)]
	cut := maxSourceFilenameBytes - len(extension)
	for cut > 0 && !utf8.RuneStart(stem[cut]) {
		cut--
	}
	return stem[:cut] + extension
}
