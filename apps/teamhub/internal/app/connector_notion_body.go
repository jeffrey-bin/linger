package app

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	ext "github.com/yuin/goldmark/extension/ast"
	gmtext "github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

type notionBody struct {
	Markdown string           `json:"markdown"`
	Blocks   []map[string]any `json:"blocks"`
}
type notionConverter struct {
	source []byte
	count  int
}

func prepareNotionBody(content string, markdown bool) (notionBody, error) {
	result := notionBody{Blocks: []map[string]any{}}
	if len(content) > 1<<20 || !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return result, fmt.Errorf("invalid content")
	}
	if !markdown {
		result.Markdown = escapeNotionMarkdown(content)
		if content != "" {
			for _, paragraph := range strings.Split(content, "\n\n") {
				result.Blocks = append(result.Blocks, notionTextBlock("paragraph", notionRichText(paragraph, nil, "")))
			}
		}
	} else {
		parser := goldmark.New(goldmark.WithExtensions(extension.GFM))
		converter := notionConverter{source: []byte(content)}
		root := parser.Parser().Parse(gmtext.NewReader(converter.source))
		blocks, err := converter.blocks(root, 0)
		if err != nil {
			return result, err
		}
		result.Blocks = blocks
		result.Markdown = content
	}
	if len(result.Blocks) > 100 {
		return result, fmt.Errorf("at most 100 top level blocks")
	}
	if err := validateNotionBlocks(result.Blocks); err != nil {
		return result, err
	}
	return result, nil
}
func validateNotionBlocks(blocks []map[string]any) error {
	encoded, err := json.Marshal(blocks)
	if err != nil || len(encoded) > 480000 {
		return fmt.Errorf("Notion request exceeds its size limit")
	}
	count := 0
	var visit func(any) error
	visit = func(value any) error {
		switch node := value.(type) {
		case map[string]any:
			if node["object"] == "block" {
				count++
				if count > 500 {
					return fmt.Errorf("too many nested blocks")
				}
			}
			for key, child := range node {
				if key == "rich_text" {
					if entries, ok := child.([]map[string]any); ok && len(entries) > 100 {
						return fmt.Errorf("too many text fragments")
					}
				}
				if err := visit(child); err != nil {
					return err
				}
			}
		case []map[string]any:
			for _, child := range node {
				if err := visit(child); err != nil {
					return err
				}
			}
		case [][]map[string]any:
			for _, child := range node {
				if err := visit(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return visit(blocks)
}
func escapeNotionMarkdown(value string) string {
	var b strings.Builder
	for _, r := range value {
		if strings.ContainsRune("\\`*_{}[]()<>#+-.!|~=&", r) {
			b.WriteRune('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}
func notionRichText(value string, annotations map[string]any, link string) []map[string]any {
	out := []map[string]any{}
	runes := []rune(value)
	for len(runes) > 0 {
		end, units := 0, 0
		for end < len(runes) {
			size := utf16.RuneLen(runes[end])
			if units+size > 2000 {
				break
			}
			units += size
			end++
		}
		t := map[string]any{"content": string(runes[:end])}
		if link != "" {
			t["link"] = map[string]any{"url": link}
		}
		part := map[string]any{"type": "text", "text": t}
		if len(annotations) > 0 {
			part["annotations"] = annotations
		}
		out = append(out, part)
		runes = runes[end:]
	}
	return out
}
func notionTextBlock(kind string, rich []map[string]any) map[string]any {
	return map[string]any{"object": "block", "type": kind, kind: map[string]any{"rich_text": rich}}
}
func notionURL(value string, image bool) error {
	u, err := url.Parse(value)
	if err != nil || u.User != nil || len(value) > 2000 || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("invalid URL")
	}
	if !image {
		if (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" {
			return nil
		}
		if u.Scheme == "mailto" && strings.Contains(u.Opaque, "@") {
			return nil
		}
		return fmt.Errorf("use HTTP, HTTPS or mailto links")
	}
	if u.Hostname() == "" || u.Scheme != "https" {
		return fmt.Errorf("use public HTTPS URLs")
	}
	host := strings.ToLower(u.Hostname())
	ip := net.ParseIP(host)
	if host == "localhost" || !strings.Contains(host, ".") || strings.HasSuffix(host, ".local") || (ip != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified())) {
		return fmt.Errorf("use public HTTPS URLs")
	}
	return nil
}
func (c *notionConverter) inline(parent ast.Node, annotations map[string]any, link string) ([]map[string]any, error) {
	out := []map[string]any{}
	for n := parent.FirstChild(); n != nil; n = n.NextSibling() {
		attrs := map[string]any{}
		for k, v := range annotations {
			attrs[k] = v
		}
		switch x := n.(type) {
		case *ast.Text:
			value := string(util.ResolveEntityNames(util.ResolveNumericReferences(util.UnescapePunctuations(x.Value(c.source)))))
			if x.SoftLineBreak() || x.HardLineBreak() {
				value += "\n"
			}
			out = append(out, notionRichText(value, attrs, link)...)
		case *ast.String:
			out = append(out, notionRichText(string(x.Value), attrs, link)...)
		case *ast.Emphasis:
			if x.Level == 2 {
				attrs["bold"] = true
			} else {
				attrs["italic"] = true
			}
			children, err := c.inline(n, attrs, link)
			if err != nil {
				return nil, err
			}
			out = append(out, children...)
		case *ast.CodeSpan:
			attrs["code"] = true
			out = append(out, notionRichText(string(x.Text(c.source)), attrs, link)...)
		case *ast.Link:
			dest := string(x.Destination)
			if err := notionURL(dest, false); err != nil {
				return nil, err
			}
			children, err := c.inline(n, attrs, dest)
			if err != nil {
				return nil, err
			}
			out = append(out, children...)
		case *ast.AutoLink:
			dest := string(x.URL(c.source))
			if err := notionURL(dest, false); err != nil {
				return nil, err
			}
			out = append(out, notionRichText(string(x.Label(c.source)), attrs, dest)...)
		case *ext.TaskCheckBox: // represented by the enclosing to_do block
		default:
			return nil, fmt.Errorf("unsupported inline Markdown: %s", n.Kind())
		}
	}
	return out, nil
}
func (c *notionConverter) blocks(parent ast.Node, depth int) ([]map[string]any, error) {
	if depth > 2 {
		return nil, fmt.Errorf("Markdown nesting exceeds the supported depth")
	}
	out := []map[string]any{}
	for n := parent.FirstChild(); n != nil; n = n.NextSibling() {
		c.count++
		if c.count > 500 {
			return nil, fmt.Errorf("too many blocks")
		}
		kind := ""
		var block map[string]any
		switch x := n.(type) {
		case *ast.Paragraph, *ast.TextBlock:
			if img, ok := n.FirstChild().(*ast.Image); ok && img.NextSibling() == nil {
				dest := string(img.Destination)
				if err := notionURL(dest, true); err != nil {
					return nil, err
				}
				caption, err := c.inline(img, nil, "")
				if err != nil {
					return nil, err
				}
				block = map[string]any{"object": "block", "type": "image", "image": map[string]any{"type": "external", "external": map[string]any{"url": dest}, "caption": caption}}
			} else {
				kind = "paragraph"
			}
		case *ast.Heading:
			if x.Level > 3 {
				return nil, fmt.Errorf("only headings 1 to 3 are supported")
			}
			kind = fmt.Sprintf("heading_%d", x.Level)
		case *ast.ThematicBreak:
			block = map[string]any{"object": "block", "type": "divider", "divider": map[string]any{}}
		case *ast.List:
			for item := n.FirstChild(); item != nil; item = item.NextSibling() {
				children, err := c.blocks(item, depth+1)
				if err != nil {
					return nil, err
				}
				if len(children) == 0 {
					return nil, fmt.Errorf("empty list item")
				}
				listKind := "bulleted_list_item"
				if x.IsOrdered() {
					listKind = "numbered_list_item"
				}
				first := children[0]
				if first["type"] != "paragraph" {
					return nil, fmt.Errorf("list items must start with text")
				}
				data := first["paragraph"].(map[string]any)
				if box, ok := item.FirstChild().FirstChild().(*ext.TaskCheckBox); ok {
					listKind = "to_do"
					data["checked"] = box.IsChecked
				}
				if len(children) > 1 {
					data["children"] = children[1:]
				}
				out = append(out, map[string]any{"object": "block", "type": listKind, listKind: data})
			}
			continue
		case *ast.Blockquote:
			children, err := c.blocks(n, depth+1)
			if err != nil {
				return nil, err
			}
			if len(children) == 0 {
				return nil, fmt.Errorf("empty quote")
			}
			if children[0]["type"] != "paragraph" {
				return nil, fmt.Errorf("quote must start with text")
			}
			data := children[0]["paragraph"].(map[string]any)
			if len(children) > 1 {
				data["children"] = children[1:]
			}
			block = map[string]any{"object": "block", "type": "quote", "quote": data}
		case *ast.FencedCodeBlock:
			lang := string(x.Language(c.source))
			if lang == "" {
				lang = "plain text"
			}
			aliases := map[string]string{"js": "javascript", "ts": "typescript", "py": "python", "sh": "shell", "bash": "bash", "text": "plain text", "txt": "plain text", "yml": "yaml"}
			if name, ok := aliases[lang]; ok {
				lang = name
			}
			if !strings.Contains("|plain text|javascript|typescript|python|shell|bash|go|rust|java|json|yaml|sql|html|css|ruby|c|c++|c#|swift|kotlin|markdown|docker|", "|"+lang+"|") { //nolint:gocritic // argument order is haystack then needle; gocritic misreads the literal list as the needle
				return nil, fmt.Errorf("unsupported code language")
			}
			block = notionTextBlock("code", notionRichText(string(x.Text(c.source)), nil, ""))
			block["code"].(map[string]any)["language"] = lang
		case *ext.Table:
			rows := []map[string]any{}
			width := len(x.Alignments)
			for row := n.FirstChild(); row != nil; row = row.NextSibling() {
				cells := [][]map[string]any{}
				for cell := row.FirstChild(); cell != nil; cell = cell.NextSibling() {
					rich, err := c.inline(cell, nil, "")
					if err != nil {
						return nil, err
					}
					cells = append(cells, rich)
				}
				if len(cells) != width {
					return nil, fmt.Errorf("table must be rectangular")
				}
				rows = append(rows, map[string]any{"object": "block", "type": "table_row", "table_row": map[string]any{"cells": cells}})
			}
			if len(rows) > 100 {
				return nil, fmt.Errorf("table exceeds 100 rows")
			}
			block = map[string]any{"object": "block", "type": "table", "table": map[string]any{"table_width": width, "has_column_header": true, "has_row_header": false, "children": rows}}
		default:
			return nil, fmt.Errorf("unsupported block Markdown: %s", n.Kind())
		}
		if kind != "" {
			rich, err := c.inline(n, nil, "")
			if err != nil {
				return nil, err
			}
			block = notionTextBlock(kind, rich)
		}
		out = append(out, block)
	}
	return out, nil
}
