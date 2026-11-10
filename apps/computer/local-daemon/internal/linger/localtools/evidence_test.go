package localtools

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"math/rand/v2"
	"path/filepath"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

func cuaRead(t *testing.T, text string, structured map[string]string) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"content": []any{map[string]string{"type": "text", "text": text}}, "structuredContent": structured})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestWindowReadsNameTheRowATokenPointsAt(t *testing.T) {
	var reads windowReads
	reads.observe(cuaRead(t, "window_id=9 pid=42 size=800x600 elements=4 snapshot_id=s1\nelement_token for row [N] = s1:N\n- [0] AXWindow \"Inbox\"\n  - [1] AXTabGroup\n    - [2] AXRadioButton \"Drafts\" [id=drafts]\n    - [3] AXButton \"Send\" = \"\" (Sends the mail) [actions=[press]]\n    - [4] AXButton (Close tab)",
		map[string]string{"snapshot_id": "s1"}))
	for token, want := range map[string]permission.DesktopTarget{
		"s1:2": {Role: "AXRadioButton", Name: "Drafts"},
		"s1:3": {Role: "AXButton", Name: "Send"},
		"s1:4": {Role: "AXButton", Name: "Close tab"},
	} {
		key, row, ok := reads.row(token)
		role, name := rowTarget(row)
		if !ok || key != (windowKey{pid: 42, window: 9}) || role != want.Role || name != want.Name {
			t.Errorf("%s: %v %q %q %q", token, ok, row, role, name)
		}
	}
	// A read since s1 shifts rows after an inserted one; s1's tokens are stale.
	reads.observe(cuaRead(t, "window_id=9 pid=42 snapshot_id=s2\nsince s1: 1 added, 1 changed, 1 removed.\n+ [2] AXRadioButton \"Sent\"\n~ [4] AXButton \"Send now\"\n- [4] AXButton (Close tab)\nreindexed: [2-3] -> [3-4]",
		map[string]string{"snapshot_id": "s2", "since": "s1", "since_status": "diff"}))
	if _, _, ok := reads.row("s1:3"); ok {
		t.Fatal("a token from the replaced snapshot resolved")
	}
	for token, want := range map[string]string{"s2:1": "AXTabGroup", "s2:2": `AXRadioButton "Sent"`, "s2:3": `AXRadioButton "Drafts" [id=drafts]`, "s2:4": `AXButton "Send now"`} {
		if _, row, ok := reads.row(token); !ok || row != want {
			t.Errorf("%s: %v %q", token, ok, row)
		}
	}
	reads.observe(cuaRead(t, "window_id=9 pid=42 snapshot_id=s3\nno change since s2.", map[string]string{"snapshot_id": "s3", "since": "s2", "since_status": "no_change"}))
	if _, row, ok := reads.row("s3:2"); !ok || row != `AXRadioButton "Sent"` {
		t.Fatalf("no change: %v %q", ok, row)
	}
	// Unlisted shifts leave the rows unknown rather than misnumbered.
	reads.observe(cuaRead(t, "window_id=9 pid=42 snapshot_id=s4\nreindexed: more shifted ranges not listed; pass full_output or omit since for a fresh index.", map[string]string{"snapshot_id": "s4", "since": "s3", "since_status": "diff"}))
	if _, _, ok := reads.row("s4:2"); ok {
		t.Fatal("rows resolved after unlisted shifts")
	}
}

func TestBrowserPagesNameTheElementAReferencePointsAt(t *testing.T) {
	var pages browserPages
	result, _ := json.Marshal(map[string]any{"content": []any{map[string]string{"type": "text", "text": "### Page\n- Page URL: https://git.example.com/merge_requests/7\n- Page Title: Fix login · GitLab\n### Snapshot\n```yaml\n- main [ref=e2]:\n  - button \"Merge\" [ref=e19] [cursor=pointer]\n  - textbox \"Comment \\\"draft\\\"\" [disabled] [ref=e20]\n```"}}})
	pages.observe(result)
	if url, title := pages.current(); url != "https://git.example.com/merge_requests/7" || title != "Fix login · GitLab" {
		t.Fatalf("page: %q %q", url, title)
	}
	for ref, want := range map[string][2]string{"e19": {"button", "Merge"}, "e20": {"textbox", `Comment "draft"`}, "e2": {"main", ""}} {
		if role, name, ok := pages.element(ref); !ok || role != want[0] || name != want[1] {
			t.Errorf("%s: %v %q %q", ref, ok, role, name)
		}
	}
}

func TestBrowserNavigationFollowsTheLinksAndSiteOfTheCurrentPage(t *testing.T) {
	var pages browserPages
	snapshot := func(page, links string) {
		result, _ := json.Marshal(map[string]any{"content": []any{map[string]string{"type": "text", "text": "### Page\n- Page URL: " + page + "\n### Snapshot\n```yaml\n" + links + "```"}}})
		pages.observe(result)
	}
	snapshot("https://docs.example.com/guide/start", "- link \"Next\" [ref=e4] [cursor=pointer]:\n  - /url: ../api#top\n- link \"Paper\" [ref=e5]:\n  - /url: \"https://arxiv.org/abs/1234: v2\"\n- link \"Page\" [ref=e6]:\n  - /url: https://other.org/x\n")
	// A snapshot of only what changed adds its links to the page's.
	snapshot("https://docs.example.com/guide/start", "- link \"Later\" [ref=e7]:\n  - /url: https://later.net/\n")
	for address, want := range map[string]bool{
		"https://docs.example.com/api":          true,
		"https://docs.example.com/api#usage":    true,
		"https://arxiv.org/abs/1234: v2":        true,
		"https://other.org/x":                   true,
		"https://later.net/":                    true,
		"https://www.example.com/pricing":       true,
		"http://example.com/":                   true,
		"https://other.org/y":                   false,
		"https://example.com.evil.io/":          false,
		"https://user:secret@docs.example.com/": false,
		"file:///etc/passwd":                    false,
		"javascript:alert(1)":                   false,
		"docs.example.com/api":                  false,
	} {
		if got := pages.followsPage(address); got != want {
			t.Errorf("%s: %v", address, got)
		}
	}
	// A new page forgets the old page's links.
	snapshot("https://news.site.io/", "")
	if pages.followsPage("https://other.org/x") {
		t.Error("a link of the earlier page was still followed")
	}
	// Sites on a public suffix, IP addresses, and localhost match only
	// themselves.
	for page, target := range map[string]string{
		"https://alice.github.io/": "https://mallory.github.io/",
		"http://10.0.0.5:8080/":    "http://10.0.0.6:8080/",
		"http://localhost:3000/":   "http://localhost:4000/",
	} {
		snapshot(page, "")
		if pages.followsPage(target) {
			t.Errorf("%s followed to %s", page, target)
		}
	}
	snapshot("http://localhost:3000/a", "")
	if !pages.followsPage("http://localhost:3000/b") {
		t.Error("the same local server was not followed")
	}
	var blank browserPages
	if blank.followsPage("https://example.com/") {
		t.Error("followed with no page")
	}
}

func TestScreenshotEvidenceIsAJPEGWithItsSize(t *testing.T) {
	picture := image.NewRGBA(image.Rect(0, 0, 40, 30))
	picture.Set(3, 4, color.RGBA{R: 255, A: 255})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	result, _ := json.Marshal(map[string]any{"content": []any{map[string]string{"type": "text", "text": "window"}, map[string]string{"type": "image", "mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(encoded.Bytes())}}})
	shot := screenshotFromResult(result)
	if shot == nil || shot.MediaType != "image/jpeg" || shot.Width != 40 || shot.Height != 30 {
		t.Fatalf("screenshot: %+v", shot)
	}
	data, _ := base64.StdEncoding.DecodeString(shot.Data)
	if !bytes.HasPrefix(data, []byte{0xff, 0xd8, 0xff}) {
		t.Fatal("not a JPEG")
	}
}

func TestScreenshotEvidenceShrinksARetinaCapture(t *testing.T) {
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2560, 1600))); err != nil {
		t.Fatal(err)
	}
	if shot := screenshotEvidence(encoded.Bytes()); shot == nil || shot.Width != 1280 || shot.Height != 800 {
		t.Fatalf("screenshot: %+v", shot)
	}
}

// A base64 string longer than one Runner Gateway JSON string fails the whole
// permission request, so a busy full-screen capture is shrunk until it fits.
func TestScreenshotEvidenceFitsOneRunnerGatewayString(t *testing.T) {
	noise := rand.New(rand.NewPCG(1, 2))
	picture := image.NewRGBA(image.Rect(0, 0, 1600, 1000))
	for index := range picture.Pix {
		picture.Pix[index] = uint8(noise.UintN(256))
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	shot := screenshotEvidence(encoded.Bytes())
	if shot == nil || len(shot.Data) > 262144 || shot.Width >= 1600 || shot.Width*1000 != shot.Height*1600 {
		t.Fatalf("screenshot: %v", shot != nil && len(shot.Data) <= 262144)
	}
}

// Any read that walks the tree replaces the window's snapshot and stales
// the token the Agent is about to use, so evidence takes a display-only
// capture.
func TestCuaEvidenceCapturesTheWindowWithoutReplacingItsSnapshot(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view", marker)
	c.op.reads.observe(cuaRead(t, "window_id=9 pid=42 snapshot_id=s1\n- [3] AXButton \"Send\"", map[string]string{"snapshot_id": "s1"}))
	evidence := c.evidence(t.Context(), json.RawMessage(`{"pid":42,"element_token":"s1:3"}`))
	if evidence == nil || evidence.Desktop == nil || evidence.Desktop.WindowTitle != "b" ||
		len(evidence.Desktop.Targets) != 1 || evidence.Desktop.Targets[0] != (permission.DesktopTarget{Token: "s1:3", Role: "AXButton", Name: "Send"}) {
		t.Fatalf("evidence: %+v", evidence)
	}
	calls := fixtureCalls(t, marker)
	if len(calls) != 1 || calls[0].Name != "get_window_state" || calls[0].Arguments["display_only"] != true ||
		calls[0].Arguments["include_accessibility_tree"] != false || calls[0].Arguments["window_id"] != float64(9) {
		t.Fatalf("driver calls: %v", calls)
	}
	if _, _, ok := c.op.reads.row("s1:3"); !ok {
		t.Fatal("the capture replaced the remembered rows")
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLinuxEvidenceNamesTheNumberedElement(t *testing.T) {
	var index elementIndex
	index.describe(&windowState{Window: "Untitled 1 - LibreOffice Calc", App: "soffice", Elements: []windowElement{
		{Ref: json.RawMessage(`"a"`), Role: "push button", Name: "Save"},
		{Ref: json.RawMessage(`"b"`), Role: "text", Name: "Name Box"},
	}})
	role, name, window, app, ok := index.target(1)
	if !ok || role != "push button" || name != "Save" || window != "Untitled 1 - LibreOffice Calc" || app != "soffice" {
		t.Fatalf("target: %v %q %q %q %q", ok, role, name, window, app)
	}
	if _, _, _, _, ok := index.target(3); ok {
		t.Fatal("an unknown number resolved")
	}
}
