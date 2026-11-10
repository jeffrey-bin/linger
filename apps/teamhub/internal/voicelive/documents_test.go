package voicelive

import (
	"testing"
)

func TestDocumentEditsAreNativeEdits(t *testing.T) {
	if edit, problem := DocumentEdit(DocumentArguments{Command: "append", Content: "## Conclusion\n\nShip next week"}); problem != "" || edit["command"] != "append" || edit["content"] != "## Conclusion\n\nShip next week" {
		t.Fatalf("append=%v %s", edit, problem)
	}
	if edit, problem := DocumentEdit(DocumentArguments{Command: "replace_text", Find: "9 am", ReplaceWith: "3 pm"}); problem != "" ||
		edit["command"] != "str_replace" || edit["pattern"] != "9 am" || edit["content"] != "3 pm" {
		t.Fatalf("replace=%v %s", edit, problem)
	}
	for _, args := range []DocumentArguments{
		{Command: "append", Content: " "},
		{Command: "replace_text", Find: "two lines\nof text", ReplaceWith: "x"},
		{Command: "replace_text", ReplaceWith: "x"},
		{Command: "replace_text", Find: "Q4 launch is set for December 10.", Content: "x"},
		{Command: "delete"},
	} {
		if _, problem := DocumentEdit(args); problem == "" {
			t.Fatalf("%+v accepted", args)
		}
	}
	if title, ok := DocumentTitle(" Wed pickup \n draft "); !ok || title != "Wed pickup draft" {
		t.Fatalf("title=%q", title)
	}
	if _, ok := DocumentTitle(" \n "); ok {
		t.Fatal("empty title accepted")
	}
}

func TestCommentAnchorIsTheOneBlockAQuoteIsIn(t *testing.T) {
	export := []byte(`{"blocks":[
		{"id":"b1","type":"heading","content":[{"type":"text","text":"Launch plan"}]},
		{"id":"b2","type":"paragraph","content":[{"type":"text","text":"Next Wed "},{"type":"link","href":"https://x","content":[{"type":"text","text":"canary"}]},{"type":"text","text":" rollout"}],
		 "children":[{"id":"b3","type":"paragraph","content":[{"type":"text","text":"Owner: Ray Zhao"}]}]},
		{"id":"b4","type":"table","content":{"type":"tableContent","rows":[]}}
	]}`)
	blocks, ok := DocumentBlocks(export)
	if !ok || len(blocks) != 4 || blocks[1].Text != "Next Wed canary rollout" || blocks[2].ID != "b3" || blocks[3].Text != "" {
		t.Fatalf("blocks=%+v", blocks)
	}
	if id, problem := CommentAnchor(blocks, "canary rollout"); id != "b2" || problem != "" {
		t.Fatalf("anchor=%s %s", id, problem)
	}
	for _, quote := range []string{"rollout time", " "} {
		if _, problem := CommentAnchor(blocks, quote); problem != "quote_not_found" {
			t.Fatalf("%q problem=%s", quote, problem)
		}
	}
	blocks = append(blocks, DocumentBlock{ID: "b5", Text: "canary rollout after"})
	if _, problem := CommentAnchor(blocks, "canary rollout"); problem != "ambiguous_quote" {
		t.Fatalf("ambiguous=%s", problem)
	}
}
