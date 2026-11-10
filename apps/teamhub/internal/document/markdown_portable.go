package document

import (
	"bytes"
	"slices"
	"strings"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// MaxPortableBytes bounds a Markdown download with its media inlined.
const MaxPortableBytes = 64 << 20

// InlineAssets rewrites each document-asset: link or image destination of a
// Markdown download to the URI resolve returns. Only parsed destinations
// change: text and code spans may hold the same bytes as a real media
// reference and stay literal examples.
func InlineAssets(source []byte, resolve func(string) (string, error)) ([]byte, error) {
	if len(source) > MaxPortableBytes {
		return nil, ErrTooLarge
	}
	type replacement struct {
		start, end int
		id         string
	}
	replacements := map[int]replacement{}
	root := markdown.Parser().Parse(text.NewReader(source))
	type span struct{ start, end int }
	var literals []span
	_ = ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if t, ok := node.(*ast.Text); ok {
				literals = append(literals, span{t.Segment.Start, t.Segment.Stop})
			}
			if h, ok := node.(*ast.RawHTML); ok {
				for i := 0; i < h.Segments.Len(); i++ {
					seg := h.Segments.At(i)
					literals = append(literals, span{seg.Start, seg.Stop})
				}
			}
		}
		return ast.WalkContinue, nil
	})
	isLiteral := func(position int) bool {
		for _, s := range literals {
			if position >= s.start && position < s.end {
				return true
			}
		}
		return false
	}
	err := ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		var destination []byte
		switch value := node.(type) {
		case *ast.Image:
			destination = value.Destination
		case *ast.Link:
			destination = value.Destination
		default:
			return ast.WalkContinue, nil
		}
		const prefix = "document-asset:"
		if !bytes.HasPrefix(destination, []byte(prefix)) {
			return ast.WalkContinue, nil
		}
		block := node.Parent()
		for block != nil && block.Type() == ast.TypeInline {
			block = block.Parent()
		}
		if block == nil {
			return ast.WalkStop, ErrInvalidMarkdown
		}
		found := false
		for i := 0; i < block.Lines().Len(); i++ {
			segment := block.Lines().At(i)
			line := source[segment.Start:segment.Stop]
			suffix := append(append([]byte("]("), destination...), ')')
			for offset := 0; offset < len(line); {
				index := bytes.Index(line[offset:], suffix)
				if index < 0 {
					break
				}
				position := segment.Start + offset + index + 2
				offset += index + len(suffix)
				if _, exists := replacements[position]; exists || isLiteral(position) {
					continue
				}
				replacements[position] = replacement{position, position + len(destination), strings.TrimPrefix(string(destination), prefix)}
				found = true
				break
			}
			if found {
				break
			}
		}
		if !found {
			return ast.WalkStop, ErrInvalidMarkdown
		}
		return ast.WalkContinue, nil
	})
	if err != nil {
		return nil, err
	}
	ordered := make([]replacement, 0, len(replacements))
	for _, r := range replacements {
		ordered = append(ordered, r)
	}
	slices.SortFunc(ordered, func(a, b replacement) int { return a.start - b.start })
	var output bytes.Buffer
	offset := 0
	for _, r := range ordered {
		uri, err := resolve(r.id)
		if err != nil {
			return nil, err
		}
		if output.Len()+r.start-offset+len(uri)+len(source)-r.end > MaxPortableBytes {
			return nil, ErrTooLarge
		}
		output.Write(source[offset:r.start])
		output.WriteString(uri)
		offset = r.end
	}
	output.Write(source[offset:])
	return output.Bytes(), nil
}
