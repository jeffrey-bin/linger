package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNotionBodyPreservesFormattingAndFragments(t *testing.T) {
	body, err := prepareNotionBody("# Plan\n\n**Bold** and \\*literal\\* &amp; [link](https://example.com).\n\n- [x] done\n  - nested\n\n```python\nprint(1)\n```\n\n| Name | Value |\n| --- | --- |\n| Item | 1 |\n\n![Caption](https://example.com/image.png)", true)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(body.Blocks)
	value := string(encoded)
	for _, want := range []string{`"heading_1"`, `"bold":true`, `*literal*`, `\u0026 `, `"checked":true`, `"bulleted_list_item"`, `"language":"python"`, `"table_width":2`, `"type":"external"`} {
		if !strings.Contains(value, want) {
			t.Errorf("missing %s in %s", want, value)
		}
	}
	long := strings.Repeat("€", 4027)
	plain, err := prepareNotionBody(long, false)
	if err != nil {
		t.Fatal(err)
	}
	rich := plain.Blocks[0]["paragraph"].(map[string]any)["rich_text"].([]map[string]any)
	joined := ""
	for _, part := range rich {
		fragment := part["text"].(map[string]any)["content"].(string)
		if len([]rune(fragment)) > 2000 {
			t.Fatal("oversized fragment")
		}
		joined += fragment
	}
	if joined != long || len(plain.Blocks) != 1 {
		t.Fatal("paragraph bytes or boundaries changed")
	}
}
func TestNotionBodyRejectsUnsupportedBeforeWriting(t *testing.T) {
	for _, content := range []string{"#### heading", "<script>bad</script>", "![local](./private.png)", "```unknown-lang\nx\n```", strings.Repeat("paragraph\n\n", 101)} {
		if _, err := prepareNotionBody(content, true); err == nil {
			t.Errorf("accepted unsupported body %q", content)
		}
	}
}

func TestNotionBodyCountsAstralCharactersInTextFragments(t *testing.T) {
	body, err := prepareNotionBody(strings.Repeat("😀", 1001), false)
	if err != nil {
		t.Fatal(err)
	}
	fragments := body.Blocks[0]["paragraph"].(map[string]any)["rich_text"].([]map[string]any)
	if len(fragments) != 2 || len([]rune(fragments[0]["text"].(map[string]any)["content"].(string))) != 1000 {
		t.Fatal("astral characters exceeded the 2000 UTF-16 unit limit")
	}
}

func TestNotionLinksAreNotRestrictedLikeExternalImages(t *testing.T) {
	body, err := prepareNotionBody("[HTTP](http://example.com) and [Email](mailto:alice@example.com)", true)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(body.Blocks)
	for _, want := range []string{"http://example.com", "mailto:alice@example.com"} {
		if !strings.Contains(string(encoded), want) {
			t.Fatalf("lost link %s", want)
		}
	}
	for _, value := range []string{"![Image](http://example.com/a.png)", "![Image](https://localhost/a.png)", "[Link](javascript:alert)"} {
		if _, err := prepareNotionBody(value, true); err == nil {
			t.Errorf("accepted %s", value)
		}
	}
}
