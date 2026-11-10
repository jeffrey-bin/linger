package agentconnectedapps

import (
	"encoding/json"
	"errors"
	"maps"
	"strings"
	"testing"
)

// canvasCode is a canvas whose first block is a code block with this text.
func canvasCode(t *testing.T, text string) []CanvasBlock {
	t.Helper()
	content, err := json.Marshal([]map[string]any{{"type": "text", "text": text, "styles": map[string]any{}}})
	if err != nil {
		t.Fatal(err)
	}
	return []CanvasBlock{{Type: "codeBlock", Content: content}, {Type: "paragraph"}}
}

// The same cases as Web's canvas-document.test.ts: both read the header
// with one syntax.
func TestCanvasHeaderReadsLikeWeb(t *testing.T) {
	for _, tc := range []struct {
		name, text, target string
		fields             map[string]string
	}{
		{"fields", "canvas: gmail\nto: lisa@acme.com\ncc:\nsubject: Follow-up: pricing\nstatus: draft", "gmail",
			map[string]string{"to": "lisa@acme.com", "cc": "", "subject": "Follow-up: pricing", "status": "draft"}},
		{"upper case", "Canvas: Gmail\nTO: a@b.co\nSubject: Hi", "gmail", map[string]string{"to": "a@b.co", "subject": "Hi"}},
		{"one line", "canvas: gmail", "gmail", map[string]string{}},
		{"semicolons", "canvas: gmail\nto: a@b.co; c@d.co", "gmail", map[string]string{"to": "a@b.co; c@d.co"}},
		{"unknown fields", "canvas: gmail\nnote: keep\nx-y: dropped\nsubject: Old\nsubject: New", "gmail",
			map[string]string{"note": "keep", "subject": "New"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			header, ok := ReadCanvasHeader(canvasCode(t, tc.text))
			if !ok || header.Target != tc.target || !maps.Equal(header.Fields, tc.fields) {
				t.Fatalf("header=%+v ok=%t", header, ok)
			}
		})
	}
	paragraph := []CanvasBlock{{Type: "paragraph", Content: json.RawMessage(`[{"type":"text","text":"canvas: gmail"}]`)}}
	for name, blocks := range map[string][]CanvasBlock{
		"paragraph":        paragraph,
		"ordinary code":    canvasCode(t, "const canvas = 1;"),
		"later code block": append(paragraph, canvasCode(t, "canvas: gmail")...),
		"empty document":   nil,
		"table content":    {{Type: "table", Content: json.RawMessage(`{"type":"tableContent","rows":[]}`)}},
	} {
		if header, ok := ReadCanvasHeader(blocks); ok {
			t.Fatalf("%s read as a canvas: %+v", name, header)
		}
	}
}

// Addresses are separated by commas only: a semicolon list stays one address,
// which the draft then refuses.
func TestCanvasRecipientsSplitOnCommasOnly(t *testing.T) {
	if list := *commaList(" a@b.co, c@d.co ,,"); len(list) != 2 || list[0] != "a@b.co" || list[1] != "c@d.co" {
		t.Fatalf("list=%q", list)
	}
	semicolons := *commaList("a@b.co; c@d.co")
	if len(semicolons) != 1 {
		t.Fatalf("list=%q", semicolons)
	}
	if _, err := BuildGmailDraftRaw(GmailDraftMessage{To: semicolons, Subject: "Hi", HTML: "<p>Hi</p>"}); err == nil {
		t.Fatal("a semicolon-separated list was accepted as one recipient")
	}
}

func TestCanvasMailBodyDropsHeaderAndReferencesImagesByCID(t *testing.T) {
	markdown := "```\ncanvas: gmail\nto: lisa@acme.example\nsubject: Hi\n```\n\nHi Lisa,\n\n![Card](document-asset:document_asset_card)\n"
	body := CanvasHeaderFence.ReplaceAllString(markdown, "")
	if strings.Contains(body, "canvas:") || !strings.HasPrefix(strings.TrimSpace(body), "Hi Lisa,") {
		t.Fatalf("body=%q", body)
	}
	// The Markdown export writes the header code block as "```text".
	for _, header := range []string{"```text\ncanvas: gmail\n```\n\nHi Lisa,", "```\nCanvas: Gmail\n```\n\nHi Lisa,\n"} {
		if body := CanvasHeaderFence.ReplaceAllString(header, ""); strings.TrimSpace(body) != "Hi Lisa," {
			t.Fatalf("one-line header body=%q", body)
		}
	}
	body = canvasAssetImage.ReplaceAllString(body, "(cid:card.1@linger)")
	html, err := MailMarkdownHTML(body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(html, `<img src="cid:card.1@linger" alt="Card">`) {
		t.Fatalf("html=%s", html)
	}
	// A code block later in the body is content, not the header.
	quoted := "Intro\n\n```\ncanvas: gmail\n```\n"
	if CanvasHeaderFence.ReplaceAllString(quoted, "") != quoted {
		t.Fatal("a code block after the first block was removed")
	}
	if _, err := MailMarkdownHTML("<b>raw</b>"); !errors.Is(err, ErrMailRawHTML) {
		t.Fatalf("raw HTML err=%v", err)
	}
}

func TestMailImagesKeepTheirCanvasWidth(t *testing.T) {
	html := `<p><img src="cid:asset_card.0a1b2c3d@linger" alt="Card"></p>` +
		`<p><img src="cid:asset_photo.0a1b2c3e@linger" alt="Photo"></p>`
	sized := sizeMailImages(html, map[string]int{"asset_card": 320})
	if !strings.Contains(sized, `<img width="320" style="max-width:100%;height:auto" src="cid:asset_card.`) {
		t.Fatalf("canvas width lost: %s", sized)
	}
	if !strings.Contains(sized, `<img width="600" style="max-width:100%;height:auto" src="cid:asset_photo.`) {
		t.Fatalf("natural-size image not capped to the email width: %s", sized)
	}
}

func TestCanvasFileBlocksAreAttachedOnceInOrder(t *testing.T) {
	var blocks []CanvasBlock
	if err := json.Unmarshal([]byte(`[
		{"type":"codeBlock","content":[{"text":"canvas: gmail"}]},
		{"type":"image","props":{"url":"document-asset:asset_card"}},
		{"type":"file","props":{"url":"document-asset:asset_plan"}},
		{"type":"bulletListItem","children":[{"type":"file","props":{"url":"document-asset:asset_sheet"}}]},
		{"type":"file","props":{"url":"document-asset:asset_plan"}},
		{"type":"file","props":{"url":"https://example.com/elsewhere.pdf"}}
	]`), &blocks); err != nil {
		t.Fatal(err)
	}
	if files := canvasFileAssets(blocks); len(files) != 2 || files[0] != "asset_plan" || files[1] != "asset_sheet" {
		t.Fatalf("files=%q", files)
	}
}
