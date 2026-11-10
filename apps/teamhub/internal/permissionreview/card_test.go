package permissionreview

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTitleNamesTheActionFromTheCallAndHostEvidence(t *testing.T) {
	t.Parallel()
	const workspace = "/home/agent/work/example-repo"
	patch := "*** Begin Patch\n*** Update File: deploy/overlays/prod/values.yaml\n@@\n-    tag: 0.21.3\n+    tag: 0.22.0\n*** End Patch"
	gitlab := &BrowserEvidence{URL: "http://gitlab.example.com/group/repo/-/merge_requests/2141", Title: "feat: queue (!2141) · Merge requests · GitLab", TargetRole: "button", TargetName: "Merge"}
	cases := []struct {
		name     string
		action   Action
		evidence Evidence
		want     string
	}{
		{"script", Action{Surface: "shell", Tool: "Bash", Command: "bash scripts/cleanup-previews.sh"},
			Evidence{Script: &ScriptEvidence{Path: "scripts/cleanup-previews.sh", Body: "kubectl delete ns x"}}, "Run scripts/cleanup-previews.sh"},
		{"command", Action{Surface: "shell", Tool: "Bash", Command: "kubectl   delete ns preview-2141"}, Evidence{}, "Run kubectl delete ns preview-2141"},
		{"multi-line command", Action{Surface: "shell", Tool: "Bash", Command: "git add -A\ngit commit -m wip"}, Evidence{}, "Run git add -A …"},
		{"connector command", Action{Surface: "connected_app", Tool: "Bash", Command: "teamhub apps execute --toolSlug GMAIL_SEND_EMAIL"}, Evidence{}, "Run teamhub apps execute --toolSlug GMAIL_SEND_EMAIL"},
		{"patch", Action{Surface: "file_edit", Tool: "apply_patch", Input: `{"command":"…"}`}, Evidence{Patch: patch}, "Edit deploy/overlays/prod/values.yaml"},
		{"new file", Action{Surface: "file_edit", Tool: "apply_patch"}, Evidence{Patch: "*** Add File: docs/notes.md\n+hi"}, "Create docs/notes.md"},
		{"several files", Action{Surface: "file_edit", Tool: "apply_patch"},
			Evidence{Patch: "*** Update File: a.go\n*** Delete File: b.go\n*** Add File: c.go"}, "Edit a.go and 2 more files"},
		{"edit in workspace", Action{Surface: "file_edit", Tool: "Edit", Input: `{"file_path":"/home/agent/work/example-repo/apps/x.py","old_string":"a","new_string":"b"}`}, Evidence{}, "Edit apps/x.py"},
		{"write outside workspace", Action{Surface: "file_edit", Tool: "Write", Input: `{"file_path":"/etc/hosts","content":"x"}`}, Evidence{}, "Write /etc/hosts"},
		{"page with site", Action{Surface: "browser", Tool: "mcp__browser__browser_click", Input: `{"ref":"e42","element":"Send"}`},
			Evidence{Browser: gitlab}, `Click "Merge" · GitLab (gitlab.example.com)`},
		{"page without title", Action{Surface: "browser", Tool: "mcp__browser__browser_click"},
			Evidence{Browser: &BrowserEvidence{URL: "http://localhost:5173/rooms", TargetName: "Delete"}}, `Click "Delete" · localhost`},
		{"no page evidence ignores the Agent's element text", Action{Surface: "browser", Tool: "mcp__browser__browser_click", Input: `{"ref":"e42","element":"Merge"}`},
			Evidence{}, "Click in the browser"},
		{"navigate", Action{Surface: "browser", Tool: "mcp__browser__browser_navigate", Input: `{"url":"https://www.alibaba.com/trade"}`}, Evidence{}, "Open www.alibaba.com"},
		{"desktop click", Action{Surface: "computer", Tool: "mcp__computer__click", Input: `{"x":452,"y":229}`}, Evidence{}, "Click on the desktop"},
		{"desktop element", Action{Surface: "computer", Tool: "mcp__computer__click", Input: `{"pid":42,"element_token":"s1:3"}`},
			Evidence{Desktop: &DesktopEvidence{App: "Mail", WindowTitle: "Inbox", Targets: []DesktopTarget{{Token: "s1:3", Role: "AXButton", Name: "Send"}}}}, `Click "Send" in Mail`},
		{"desktop steps", Action{Surface: "computer", Tool: "mcp__computer__run_actions", Input: `{"actions":[{"tool":"double_click","element_token":"s1:3"},{"tool":"type_text","text":"hi"}]}`},
			Evidence{Desktop: &DesktopEvidence{App: "Finder", Targets: []DesktopTarget{{Token: "s1:3", Role: "AXRow", Name: "report.pdf"}}}}, `Double-click "report.pdf" in Finder`},
		{"desktop window without app", Action{Surface: "computer", Tool: "mcp__computer__click_element", Input: `{"element":1}`},
			Evidence{Desktop: &DesktopEvidence{WindowTitle: "Untitled 1 - LibreOffice Calc", Targets: []DesktopTarget{{Token: "1", Role: "push button", Name: "Save"}}}}, `Click "Save" in Untitled 1 - LibreOffice Calc`},
		{"desktop target without window", Action{Surface: "computer", Tool: "mcp__computer__click_element", Input: `{"element":1}`},
			Evidence{Desktop: &DesktopEvidence{Targets: []DesktopTarget{{Token: "1", Role: "push button", Name: "Save"}}}}, `Click "Save" on the desktop`},
		{"desktop command", Action{Surface: "computer", Tool: "mcp__computer__run_command", Input: `{"command":"rm -rf ~/Downloads/old"}`}, Evidence{}, "Run rm -rf ~/Downloads/old"},
		{"web fetch", Action{Surface: "web", Tool: "WebFetch", Input: `{"url":"https://example.com/a"}`}, Evidence{}, "Fetch example.com"},
		{"other MCP", Action{Surface: "other", Tool: "mcp__linear__save_issue", Input: `{}`}, Evidence{}, "Use linear save_issue"},
	}
	for _, c := range cases {
		if got := Title(c.action, c.evidence, workspace); got != c.want {
			t.Errorf("%s: title=%q want %q", c.name, got, c.want)
		}
	}
}

func TestTitleKeepsTheEndOfLongPathsAndCommands(t *testing.T) {
	t.Parallel()
	path := "deploy/" + strings.Repeat("nested/", 12) + "prod/values.yaml"
	title := Title(Action{Surface: "file_edit", Tool: "Edit", Input: `{"file_path":"` + path + `"}`}, Evidence{}, "")
	if !strings.HasSuffix(title, "prod/values.yaml") || !strings.Contains(title, "…") || utf8.RuneCountInString(title) > len("Edit ")+maxTitleFragment {
		t.Fatalf("long path title=%q", title)
	}
	command := Title(Action{Surface: "shell", Tool: "Bash", Command: strings.Repeat("x", 500)}, Evidence{}, "")
	if utf8.RuneCountInString(command) > len("Run ")+maxTitleFragment {
		t.Fatalf("long command title has %d runes", utf8.RuneCountInString(command))
	}
}

func TestCardCarriesTheFullCallAndItsEvidence(t *testing.T) {
	t.Parallel()
	edit := Card(Action{Surface: "file_edit", Tool: "Edit", Input: `{"file_path":"app.py","old_string":"a = 1\nb = 2","new_string":"a = 3"}`}, Evidence{}, "", "changes shared config")
	if edit.Kind != "code" || edit.Title != "Edit app.py" || edit.Rationale != "changes shared config" || edit.Tool != "Edit" {
		t.Fatalf("edit card=%+v", edit)
	}
	if want := "--- app.py\n+++ app.py\n@@\n-a = 1\n-b = 2\n+a = 3"; edit.Patch != want {
		t.Fatalf("edit diff=%q want %q", edit.Patch, want)
	}

	shell := Card(Action{Surface: "shell", Tool: "Bash", Command: "bash run.sh", Input: `{"command":"bash run.sh","description":"run"}`},
		Evidence{Script: &ScriptEvidence{Path: "run.sh", SHA256: "abc", Body: strings.Repeat("x", maxCardEvidence+10)}}, "", "")
	if shell.Input != `{"command":"bash run.sh","description":"run"}` {
		t.Fatalf("the details must show the full native call, got %q", shell.Input)
	}
	if shell.Script == nil || shell.Script.Path != "run.sh" || utf8.RuneCountInString(shell.Script.Body) > maxCardEvidence+1 {
		t.Fatalf("script evidence=%+v", shell.Script)
	}

	click := Card(Action{Surface: "browser", Tool: "mcp__browser__browser_click", Input: `{"ref":"e42"}`},
		Evidence{
			Browser:    &BrowserEvidence{URL: "https://mail.example.com/inbox", Title: "Inbox", TargetRole: "button", TargetName: "Send"},
			Screenshot: &ScreenshotEvidence{MediaType: "image/jpeg", Data: []byte{0xFF, 0xD8, 0xFF}, Width: 1280, Height: 800},
		}, "", "")
	if click.Kind != "gui" || click.Page == nil || click.Page.TargetName != "Send" || click.Page.URL != "https://mail.example.com/inbox" {
		t.Fatalf("browser card=%+v page=%+v", click, click.Page)
	}
	// The card keeps only the image's size; the bytes are stored beside it.
	if click.Screenshot == nil || click.Screenshot.Width != 1280 || click.Screenshot.Height != 800 || click.Screenshot.URL != "" {
		t.Fatalf("browser card screenshot=%+v", click.Screenshot)
	}
	if desktop := Card(Action{Surface: "computer", Tool: "mcp__computer__click"}, Evidence{}, "", ""); desktop.Kind != "gui" || desktop.Page != nil {
		t.Fatalf("desktop card=%+v", desktop)
	}
}
