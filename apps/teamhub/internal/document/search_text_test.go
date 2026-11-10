package document

import "testing"

func TestMarkdownToSearchText(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		markdown string
		want     string
	}{
		{
			name:     "headings lists and emphasis",
			markdown: "# Release checklist\n\n- **Freeze** at 4pm\n2. Run the _smoke_ test\n> - [ ] nested task\n",
			want:     "Release checklist Freeze at 4pm Run the _smoke_ test nested task",
		},
		{
			name:     "links images and html",
			markdown: "See [Voice Call v2 plan](https://example.com/doc) ![architecture](assets/a.png) <br/> <span class=\"x\">inline</span> a < b",
			want:     "See Voice Call v2 plan architecture inline a < b",
		},
		{
			name:     "code fences keep content and identifiers",
			markdown: "```sql\nSELECT room_id FROM messages;\n```\nUse `strpos` on `body_text`.",
			want:     "SELECT room_id FROM messages; Use strpos on body_text.",
		},
		{
			name:     "tables",
			markdown: "| Field | Meaning |\n| --- | :---: |\n| status | index state |\n",
			want:     "Field Meaning status index state",
		},
		{
			name:     "whitespace collapses across lines",
			markdown: "Barge-in policy: when the user speaks\nstop playback within 200ms\n\n\nand drop unplayed frames.",
			want:     "Barge-in policy: when the user speaks stop playback within 200ms and drop unplayed frames.",
		},
		{
			name:     "NUL bytes become word boundaries",
			markdown: "\x00# Release\x00\x00checklist\n- **Deploy**\x00done 🚀\x00",
			want:     "Release checklist Deploy done 🚀",
		},
		{
			name:     "NUL-only input",
			markdown: "\x00\x00\n\x00",
			want:     "",
		},
		{
			name:     "empty",
			markdown: "\n\n```\n```\n",
			want:     "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := MarkdownToSearchText(tc.markdown); got != tc.want {
				t.Fatalf("MarkdownToSearchText(%q)\n got: %q\nwant: %q", tc.markdown, got, tc.want)
			}
		})
	}
}
