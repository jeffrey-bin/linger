// Markdown parsing for Document import and download holds no SQL,
// transactions or authority: callers own the Assets, objects and access around
// it. The Runtime imports the Markdown itself; Go only stores its embedded
// images as Document Assets.

package document

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
)

var (
	// ErrInvalidMarkdown reports Markdown, embedded media or a rendered result that a
	// Document cannot take.
	ErrInvalidMarkdown = errors.New("invalid Document Markdown")
	// ErrAssetUnresolved reports an embedded image rendered without its Asset.
	ErrAssetUnresolved = errors.New("embedded Markdown image has no Document Asset")
	// ErrTooLarge reports a portable download over MaxPortableBytes.
	ErrTooLarge = errors.New("portable Document Markdown is too large")
)

// MaxImportBytes bounds a Markdown source that imports embedded images.
const MaxImportBytes = 50 << 20

// markdown is the one Markdown configuration of Documents: imports and
// portable downloads parse with GFM alike.
var markdown = goldmark.New(goldmark.WithExtensions(extension.GFM))

// rawDataMediaPattern matches the embedded media the Runtime refuses in HTML.
// Import turns only Markdown image syntax into Document Assets, so raw HTML
// that embeds data is rejected before any Asset or Runtime work.
var rawDataMediaPattern = regexp.MustCompile(`(?i)\bsrc\s*=\s*(?:"data:|'data:|data:)`)

// MarkdownAsset is one embedded image an import stores as a Document Asset. Key
// identifies it across repeated occurrences.
type MarkdownAsset struct {
	Key, Filename, MediaType, SHA256 string
	Contents                         []byte
}

// Import is a Markdown source whose embedded images become Assets. uris maps
// each embedded image destination, as written, to its Asset key; code holds
// the byte ranges of code, whose text is never an image.
type Import struct {
	Assets []MarkdownAsset
	source []byte
	uris   map[string]string
	code   [][2]int
}

// PrepareImport parses source and collects its embedded images.
func PrepareImport(source []byte) (Import, error) {
	if len(source) > MaxImportBytes || !utf8.Valid(source) {
		return Import{}, ErrInvalidMarkdown
	}
	root := markdown.Parser().Parse(text.NewReader(source))
	prepared := Import{source: source, uris: map[string]string{}}
	seen := map[string]bool{}
	err := ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering && rawHTMLEmbedsData(source, n) {
			return ast.WalkStop, ErrInvalidMarkdown
		}
		if entering {
			prepared.code = append(prepared.code, codeRanges(n)...)
		}
		img, ok := n.(*ast.Image)
		if !entering || !ok || !strings.HasPrefix(strings.ToLower(string(img.Destination)), "data:") {
			return ast.WalkContinue, nil
		}
		asset, err := parseImage(string(img.Destination))
		if err != nil {
			return ast.WalkStop, err
		}
		if !seen[asset.Key] {
			if len(prepared.Assets) >= 4096 {
				return ast.WalkStop, ErrInvalidMarkdown
			}
			seen[asset.Key] = true
			prepared.Assets = append(prepared.Assets, asset)
		}
		prepared.uris[string(img.Destination)] = asset.Key
		return ast.WalkContinue, nil
	})
	return prepared, err
}

func rawHTMLEmbedsData(source []byte, n ast.Node) bool {
	var raw bytes.Buffer
	switch node := n.(type) {
	case *ast.RawHTML:
		for i := 0; i < node.Segments.Len(); i++ {
			segment := node.Segments.At(i)
			raw.Write(segment.Value(source))
		}
	case *ast.HTMLBlock:
		for i := 0; i < node.Lines().Len(); i++ {
			segment := node.Lines().At(i)
			raw.Write(segment.Value(source))
		}
		if node.HasClosure() {
			raw.Write(node.ClosureLine.Value(source))
		}
	default:
		return false
	}
	return rawDataMediaPattern.Match(raw.Bytes())
}

func parseImage(uri string) (MarkdownAsset, error) {
	header, payload, ok := strings.Cut(uri, ",")
	formats := map[string]string{"data:image/png;base64": "png", "data:image/jpeg;base64": "jpg", "data:image/gif;base64": "gif", "data:image/webp;base64": "webp"}
	ext, supported := formats[strings.ToLower(header)]
	if !ok || !supported {
		return MarkdownAsset{}, ErrInvalidMarkdown
	}
	contents, err := base64.StdEncoding.Strict().DecodeString(payload)
	if err != nil || len(contents) == 0 || base64.StdEncoding.EncodeToString(contents) != payload {
		return MarkdownAsset{}, ErrInvalidMarkdown
	}
	mediaType := strings.TrimSuffix(strings.TrimPrefix(strings.ToLower(header), "data:"), ";base64")
	if http.DetectContentType(contents) != mediaType {
		return MarkdownAsset{}, ErrInvalidMarkdown
	}
	digest := sha256.Sum256(contents)
	hash := hex.EncodeToString(digest[:])
	return MarkdownAsset{Key: mediaType + "\x00" + hash, Filename: fmt.Sprintf("embedded-%s.%s", hash[:16], ext), MediaType: mediaType, SHA256: hash, Contents: contents}, nil
}

// codeRanges returns the source ranges of a code span or block.
func codeRanges(n ast.Node) [][2]int {
	var ranges [][2]int
	switch node := n.(type) {
	case *ast.CodeSpan:
		for child := node.FirstChild(); child != nil; child = child.NextSibling() {
			if text, ok := child.(*ast.Text); ok {
				ranges = append(ranges, [2]int{text.Segment.Start, text.Segment.Stop})
			}
		}
	case *ast.FencedCodeBlock, *ast.CodeBlock:
		lines := n.Lines()
		for i := 0; i < lines.Len(); i++ {
			ranges = append(ranges, [2]int{lines.At(i).Start, lines.At(i).Stop})
		}
	}
	return ranges
}

// Rewrite points every embedded image at its Asset, keyed by Asset.Key, and
// returns the Markdown the Runtime imports. Code keeps its text.
func (p Import) Rewrite(assetIDs map[string]string) ([]byte, error) {
	type match struct {
		start, stop int
		id          string
	}
	var matches []match
	for uri, key := range p.uris {
		id := assetIDs[key]
		if id == "" {
			return nil, ErrAssetUnresolved
		}
		for offset := 0; ; {
			index := bytes.Index(p.source[offset:], []byte(uri))
			if index < 0 {
				break
			}
			start := offset + index
			offset = start + len(uri)
			if !p.inCode(start) {
				matches = append(matches, match{start, offset, id})
			}
		}
	}
	slices.SortFunc(matches, func(a, b match) int { return a.start - b.start })
	var rewritten bytes.Buffer
	next := 0
	for _, m := range matches {
		if m.start < next {
			continue
		}
		rewritten.Write(p.source[next:m.start])
		rewritten.WriteString("document-asset:" + m.id)
		next = m.stop
	}
	rewritten.Write(p.source[next:])
	return rewritten.Bytes(), nil
}

func (p Import) inCode(offset int) bool {
	for _, r := range p.code {
		if offset >= r[0] && offset < r[1] {
			return true
		}
	}
	return false
}
