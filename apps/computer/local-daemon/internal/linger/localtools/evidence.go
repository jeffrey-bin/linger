package localtools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png" // Cua and the Linux driver capture PNG.
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
	"golang.org/x/net/publicsuffix"
)

// evidenceTimeout bounds what one permission review waits for the target
// and screenshot; whatever is not ready by then is left out.
var evidenceTimeout = 5 * time.Second

// maxScreenshotBytes keeps a screenshot's base64 text within one Runner
// Gateway JSON string (262144 characters); a longer one fails the whole
// permission request.
const maxScreenshotBytes = 262144 / 4 * 3

// guard runs an evidence collector only while the Operation's tools are open.
func (op *operation) guard(collect func(context.Context, string, json.RawMessage) *permission.Evidence) func(context.Context, string, json.RawMessage) *permission.Evidence {
	return func(ctx context.Context, name string, input json.RawMessage) *permission.Evidence {
		op.mu.Lock()
		if op.closing {
			op.mu.Unlock()
			return nil
		}
		op.active.Add(1)
		op.mu.Unlock()
		defer op.active.Done()
		ctx, cancel := context.WithTimeout(ctx, evidenceTimeout)
		defer cancel()
		return collect(ctx, name, input)
	}
}

// browserAllowed reports whether a browser call follows the page the Agent
// is on: browser_navigate to a link of that page or its site.
func (op *operation) browserAllowed(name string, input json.RawMessage) bool {
	var args struct {
		URL string `json:"url"`
	}
	return name == "browser_navigate" && json.Unmarshal(input, &args) == nil && op.pages.followsPage(args.URL)
}

// browserEvidence names the page and target element of a browser action from
// the snapshots the Agent planned on, and captures the page. It reads no new
// snapshot: element references stay as the Agent saw them.
func (op *operation) browserEvidence(ctx context.Context, name string, input json.RawMessage) *permission.Evidence {
	var args struct {
		Target      string `json:"target"`
		StartTarget string `json:"startTarget"`
		Fields      []struct {
			Target string `json:"target"`
		} `json:"fields"`
	}
	_ = json.Unmarshal(input, &args)
	page, title := op.pages.current()
	if page == "" {
		return nil
	}
	browser := &permission.Browser{URL: page, Title: title}
	target := args.Target
	if target == "" {
		target = args.StartTarget
	}
	if role, label, ok := op.pages.element(target); ok {
		browser.TargetRole, browser.TargetName = role, label
	}
	var fields []string
	for _, field := range args.Fields {
		if role, label, ok := op.pages.element(field.Target); ok {
			fields = append(fields, field.Target+": "+role+" "+strconv.Quote(label))
		}
	}
	browser.FormFields = strings.Join(fields, "\n")
	return &permission.Evidence{Browser: browser, Screenshot: op.browserScreenshot(ctx)}
}

// screenshotLink is the file link Playwright prints for a saved screenshot.
var screenshotLink = regexp.MustCompile(`\]\(([^)\n]+\.jpeg)\)`)

// browserScreenshot captures the visible page. Playwright also saves the
// image in the Operation's output directory; that copy is removed.
func (op *operation) browserScreenshot(ctx context.Context) *permission.Screenshot {
	releaseCalls, err := op.holdBrowserCalls(ctx)
	if err != nil {
		return nil
	}
	defer releaseCalls()
	ctx, release, err := op.manager.holdLane(ctx, browserLane(op.spec.AgentID))
	if err != nil {
		return nil
	}
	defer release()
	// Playwright opens a page again before the capture when the last one
	// closed, as a browser call does.
	ctx, releaseFocus, err := op.manager.holdBrowserFocus(ctx)
	if err != nil {
		return nil
	}
	defer releaseFocus()
	if op.browser == nil {
		return nil
	}
	// Between calls the CDP proxy refuses commands and drops the connection
	// that sends one; the screenshot is a command like any other.
	if op.nativeProxy != nil && op.userChromeSession == nil {
		op.nativeProxy.resume()
		defer op.nativeProxy.pause()
	}
	result, err := op.browser.request(ctx, "tools/call", map[string]any{"name": "browser_take_screenshot", "arguments": map[string]any{"type": "jpeg"}})
	if err != nil {
		return nil
	}
	output := filepath.Clean(op.browserOutput())
	for _, link := range screenshotLink.FindAllStringSubmatch(string(result), -1) {
		if path := filepath.Join(op.spec.WorkingDirectory, filepath.FromSlash(link[1])); filepath.Dir(path) == output {
			_ = os.Remove(path)
		}
	}
	return screenshotFromResult(result)
}

// computerEvidence names the window and the elements a desktop action's
// tokens point at, and captures that window.
func (op *operation) computerEvidence(ctx context.Context, name string, input json.RawMessage) *permission.Evidence {
	if op.manager.localLinux() {
		return op.linuxEvidence(ctx, name, input)
	}
	op.cuaMu.Lock()
	cua := op.cua
	op.cuaMu.Unlock()
	if cua == nil || cua.retired() {
		return nil
	}
	return cua.evidence(ctx, input)
}

// desktopSteps are the steps a desktop call sends: the call itself, or the
// steps of run_actions.
func desktopSteps(input json.RawMessage) []map[string]any {
	var call map[string]any
	if json.Unmarshal(input, &call) != nil {
		return nil
	}
	actions, ok := call["actions"].([]any)
	if !ok {
		return []map[string]any{call}
	}
	steps := make([]map[string]any, 0, len(actions))
	for _, action := range actions {
		if step, ok := action.(map[string]any); ok {
			steps = append(steps, step)
		}
	}
	return steps
}

func (c *cuaSession) evidence(ctx context.Context, input json.RawMessage) *permission.Evidence {
	desktop := &permission.Desktop{}
	var window *windowKey
	var app any
	for _, step := range desktopSteps(input) {
		if token, ok := step["element_token"].(string); ok {
			if key, row, found := c.op.reads.row(token); found {
				role, label := rowTarget(row)
				desktop.Targets = append(desktop.Targets, permission.DesktopTarget{Token: token, Role: role, Name: label})
				if window == nil {
					window = &key
				}
			}
		}
		pid, hasPID := step["pid"].(float64)
		id, hasWindow := step["window_id"].(float64)
		if window == nil && hasPID && hasWindow {
			window = &windowKey{pid: int64(pid), window: int64(id)}
		}
		if app == nil && hasPID {
			app = pid
		}
	}
	if window == nil && app != nil {
		// Without a window, input goes to the app's focused window.
		if top, err := c.topWindow(ctx, app); err == nil && top != nil {
			window = &windowKey{pid: int64(app.(float64)), window: int64(top.WindowID)}
		}
	}
	if window == nil {
		return nil
	}
	windows, _ := c.appWindows(ctx, float64(window.pid))
	for _, listed := range windows {
		if int64(listed.WindowID) == window.window {
			desktop.App, desktop.WindowTitle = listed.AppName, listed.Title
		}
	}
	// A display-only read leaves the window's snapshot, and so the Agent's
	// element tokens, as they are.
	shot, _ := json.Marshal(map[string]any{"pid": window.pid, "window_id": window.window, "include_accessibility_tree": false, "display_only": true})
	evidence := &permission.Evidence{Desktop: desktop}
	if result, err := c.call(ctx, "get_window_state", shot); err == nil {
		evidence.Screenshot = screenshotFromResult(result)
	}
	return evidence
}

// linuxEvidence names the elements a Linux desktop action's numbers point
// at, and captures the screen.
func (op *operation) linuxEvidence(ctx context.Context, name string, input json.RawMessage) *permission.Evidence {
	desktop := &permission.Desktop{}
	for _, step := range desktopSteps(input) {
		if number, ok := step["element"].(float64); ok {
			if role, label, window, app, found := op.elements.target(int(number)); found {
				desktop.Targets = append(desktop.Targets, permission.DesktopTarget{Token: strconv.Itoa(int(number)), Role: role, Name: label})
				desktop.WindowTitle, desktop.App = window, app
			}
		}
	}
	evidence := &permission.Evidence{}
	if len(desktop.Targets) > 0 {
		evidence.Desktop = desktop
	}
	if lease, err := op.beginDesktop(ctx, false); err == nil {
		screen, err := lease.Action("screenshot")
		lease.Finish(true)
		if err == nil {
			evidence.Screenshot = screenshotEvidence(screen)
		}
	}
	if evidence.Desktop == nil && evidence.Screenshot == nil {
		return nil
	}
	return evidence
}

// screenshotFromResult takes the first image of an MCP tool result.
func screenshotFromResult(result json.RawMessage) *permission.Screenshot {
	var reply struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type string `json:"type"`
			Data string `json:"data"`
		} `json:"content"`
	}
	if json.Unmarshal(result, &reply) != nil || reply.IsError {
		return nil
	}
	for _, item := range reply.Content {
		if item.Type != "image" {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(item.Data)
		if err != nil {
			return nil
		}
		return screenshotEvidence(data)
	}
	return nil
}

// maxScreenshotSide is the longest side a screenshot keeps: the approver only
// needs to recognize the page and its target, and a smaller image keeps the
// permission request quick.
const maxScreenshotSide = 1280

// screenshotEvidence encodes a captured image as a low-quality JPEG within
// maxScreenshotSide and maxScreenshotBytes, halving its size when a lower
// quality is not enough, or returns nil.
func screenshotEvidence(data []byte) *permission.Screenshot {
	picture, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	for bounds := picture.Bounds(); max(bounds.Dx(), bounds.Dy()) > maxScreenshotSide; bounds = picture.Bounds() {
		if picture = halve(picture); picture == nil {
			return nil
		}
	}
	for range 4 {
		for _, quality := range []int{60, 45} {
			var encoded bytes.Buffer
			if jpeg.Encode(&encoded, picture, &jpeg.Options{Quality: quality}) == nil && encoded.Len() <= maxScreenshotBytes {
				bounds := picture.Bounds()
				return &permission.Screenshot{MediaType: "image/jpeg", Data: base64.StdEncoding.EncodeToString(encoded.Bytes()), Width: bounds.Dx(), Height: bounds.Dy()}
			}
		}
		if picture = halve(picture); picture == nil {
			return nil
		}
	}
	return nil
}

// halve averages each 2×2 block of a picture, or returns nil when it is too
// small to halve.
func halve(picture image.Image) image.Image {
	bounds := picture.Bounds()
	width, height := bounds.Dx()/2, bounds.Dy()/2
	if width < 1 || height < 1 {
		return nil
	}
	half := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := range height {
		for x := range width {
			var red, green, blue, alpha uint32
			for _, offset := range [4][2]int{{0, 0}, {1, 0}, {0, 1}, {1, 1}} {
				r, g, b, a := picture.At(bounds.Min.X+2*x+offset[0], bounds.Min.Y+2*y+offset[1]).RGBA()
				red, green, blue, alpha = red+r, green+g, blue+b, alpha+a
			}
			// Four 16-bit samples sum to 18 bits; keep the top 8.
			half.SetRGBA(x, y, color.RGBA{R: uint8(red >> 10), G: uint8(green >> 10), B: uint8(blue >> 10), A: uint8(alpha >> 10)})
		}
	}
	return half
}

// rowTarget reads a Cua tree row, `AXButton "Save" = "1" (Saves) [id=…]`,
// as its role and its label, or its description when it has no label.
func rowTarget(row string) (role, label string) {
	role, rest, _ := strings.Cut(strings.TrimSpace(row), " ")
	rest = strings.TrimSpace(rest)
	switch {
	case strings.HasPrefix(rest, `"`):
		label, _ = quotedPrefix(rest)
	case strings.HasPrefix(rest, "("):
		label, _, _ = strings.Cut(rest[1:], ")")
	}
	return role, label
}

// quotedPrefix reads the double-quoted string text starts with.
func quotedPrefix(text string) (string, bool) {
	for end := 1; end < len(text); end++ {
		switch text[end] {
		case '\\':
			end++
		case '"':
			if value, err := strconv.Unquote(text[:end+1]); err == nil {
				return value, true
			}
			return text[1:end], true
		}
	}
	return "", false
}

// browserPages remembers the current page and the elements of the snapshots
// the Agent has seen, by reference.
type browserPages struct {
	mu    sync.Mutex
	url   string
	title string
	refs  map[string]string
	// links are the absolute addresses, without fragment, that the current
	// page's snapshots link to.
	links map[string]bool
}

// maxPageRefs bounds the remembered elements and links; past it the oldest
// are forgotten.
const maxPageRefs = 20000

var (
	pageURL   = regexp.MustCompile(`(?m)^- Page URL: (.+)$`)
	pageTitle = regexp.MustCompile(`(?m)^- Page Title: (.+)$`)
	pageRef   = regexp.MustCompile(`(?m)^\s*- (.+?) \[ref=([A-Za-z0-9_-]+)\]`)
	pageLink  = regexp.MustCompile(`(?m)^\s*- /url: (.+)$`)
)

// observe records the page state and elements of one Playwright result.
func (p *browserPages) observe(result json.RawMessage) {
	var reply struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(result, &reply) != nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, item := range reply.Content {
		if item.Type != "text" {
			continue
		}
		if match := pageURL.FindStringSubmatch(item.Text); match != nil {
			if address := strings.TrimSpace(match[1]); address != p.url {
				p.url, p.links = address, nil
			}
			p.title = ""
		}
		if match := pageTitle.FindStringSubmatch(item.Text); match != nil {
			p.title = strings.TrimSpace(match[1])
		}
		matches := pageRef.FindAllStringSubmatch(item.Text, -1)
		if p.refs == nil || len(p.refs)+len(matches) > maxPageRefs {
			p.refs = map[string]string{}
		}
		for _, match := range matches {
			p.refs[match[2]] = match[1]
		}
		p.observeLinks(item.Text)
	}
}

// observeLinks records the links of a snapshot of the current page. A
// snapshot may show only what changed, so links add up until the page does.
func (p *browserPages) observeLinks(text string) {
	page, err := url.Parse(p.url)
	if err != nil {
		return
	}
	for _, match := range pageLink.FindAllStringSubmatch(text, -1) {
		href := strings.TrimSpace(match[1])
		if strings.HasPrefix(href, `"`) {
			href, _ = quotedPrefix(href)
		}
		link, err := page.Parse(href)
		if err != nil {
			continue
		}
		if p.links == nil || len(p.links) >= maxPageRefs {
			p.links = map[string]bool{}
		}
		link.Fragment, link.RawFragment = "", ""
		p.links[link.String()] = true
	}
}

// followsPage reports whether an address is a link of the current page or on
// its site, so going there reads like following the page. Addresses that
// carry credentials or leave http(s) do not.
func (p *browserPages) followsPage(address string) bool {
	target, err := url.Parse(address)
	if err != nil || !webAddress(target) {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	page, err := url.Parse(p.url)
	if err != nil || !webAddress(page) {
		return false
	}
	target.Fragment, target.RawFragment = "", ""
	return p.links[target.String()] || sameSite(page, target)
}

func webAddress(address *url.URL) bool {
	return (address.Scheme == "http" || address.Scheme == "https") && address.Host != "" && address.User == nil
}

// sameSite compares registrable domains, as browsers do. A host without one,
// such as an IP address or localhost, matches only itself and its port.
func sameSite(page, target *url.URL) bool {
	if strings.EqualFold(page.Host, target.Host) {
		return true
	}
	if net.ParseIP(page.Hostname()) != nil || net.ParseIP(target.Hostname()) != nil {
		return false
	}
	pageSite, err := publicsuffix.EffectiveTLDPlusOne(strings.ToLower(page.Hostname()))
	if err != nil {
		return false
	}
	targetSite, err := publicsuffix.EffectiveTLDPlusOne(strings.ToLower(target.Hostname()))
	return err == nil && pageSite == targetSite
}

func (p *browserPages) current() (page, title string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.url, p.title
}

// element reads a snapshot line, `button "Save" [disabled]`, as its role and
// accessible name.
func (p *browserPages) element(ref string) (role, label string, ok bool) {
	p.mu.Lock()
	line, found := p.refs[ref]
	p.mu.Unlock()
	if !found {
		return "", "", false
	}
	role, rest, _ := strings.Cut(line, " ")
	if strings.HasPrefix(rest, `"`) {
		label, _ = quotedPrefix(rest)
	}
	return strings.TrimSuffix(role, ":"), label, true
}

// windowKey names one desktop window.
type windowKey struct{ pid, window int64 }

// windowReads remembers the element rows of the Agent's latest read of each
// window, so a review can name the element a token points at without a read
// of its own, which would stale the Agent's tokens.
type windowReads struct {
	mu        sync.Mutex
	windows   map[windowKey]*windowRows
	snapshots map[string]windowKey
}

type windowRows struct {
	snapshot string
	rows     map[int]string
}

var (
	readHeader = regexp.MustCompile(`window_id=(\d+) pid=(\d+)`)
	treeRow    = regexp.MustCompile(`(?m)^\s*- \[(\d+)\] (.*)$`)
	diffRow    = regexp.MustCompile(`(?m)^([+~-]) \[(\d+)\] (.*)$`)
	reindexed  = regexp.MustCompile(`(?m)^reindexed: (?:\[(\d+)-(\d+)\] -> \[(-?\d+)-(-?\d+)\]|.*)$`)
)

// observe records one get_window_state result: a full read replaces the
// window's rows; a read since its latest snapshot applies the changes.
func (w *windowReads) observe(result json.RawMessage) {
	var reply struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Structured struct {
			SnapshotID  string `json:"snapshot_id"`
			Since       string `json:"since"`
			SinceStatus string `json:"since_status"`
		} `json:"structuredContent"`
	}
	if json.Unmarshal(result, &reply) != nil || reply.IsError || reply.Structured.SnapshotID == "" {
		return
	}
	var text strings.Builder
	for _, item := range reply.Content {
		if item.Type == "text" {
			text.WriteString(item.Text)
			text.WriteString("\n")
		}
	}
	header := readHeader.FindStringSubmatch(text.String())
	if header == nil {
		return
	}
	window, _ := strconv.ParseInt(header[1], 10, 64)
	pid, _ := strconv.ParseInt(header[2], 10, 64)
	key := windowKey{pid: pid, window: window}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.windows == nil {
		w.windows, w.snapshots = map[windowKey]*windowRows{}, map[string]windowKey{}
	}
	previous := w.windows[key]
	var rows map[int]string
	switch reply.Structured.SinceStatus {
	case "no_change", "diff":
		if previous == nil || previous.snapshot != reply.Structured.Since {
			delete(w.windows, key)
			return
		}
		if rows = applyDiff(previous.rows, text.String()); rows == nil {
			delete(w.windows, key)
			return
		}
	default:
		rows = map[int]string{}
		for _, match := range treeRow.FindAllStringSubmatch(text.String(), -1) {
			index, _ := strconv.Atoi(match[1])
			rows[index] = match[2]
		}
	}
	w.windows[key] = &windowRows{snapshot: reply.Structured.SnapshotID, rows: rows}
	w.snapshots[reply.Structured.SnapshotID] = key
	if len(w.snapshots) > 4*len(w.windows)+16 {
		for snapshot, owner := range w.snapshots {
			if current := w.windows[owner]; current == nil || current.snapshot != snapshot {
				delete(w.snapshots, snapshot)
			}
		}
	}
}

// applyDiff applies a `since` read to the previous rows: removed rows use
// the old indices, shifted ranges move, and added or changed rows use the
// new ones. It returns nil when the shifts are not all listed.
func applyDiff(previous map[int]string, text string) map[int]string {
	type shift struct{ first, last, delta int }
	var shifts []shift
	for _, match := range reindexed.FindAllStringSubmatch(text, -1) {
		if match[1] == "" {
			return nil
		}
		first, _ := strconv.Atoi(match[1])
		last, _ := strconv.Atoi(match[2])
		moved, _ := strconv.Atoi(match[3])
		shifts = append(shifts, shift{first, last, moved - first})
	}
	removed := map[int]bool{}
	changes := diffRow.FindAllStringSubmatch(text, -1)
	for _, match := range changes {
		if match[1] == "-" {
			index, _ := strconv.Atoi(match[2])
			removed[index] = true
		}
	}
	rows := make(map[int]string, len(previous))
	for index, row := range previous {
		if removed[index] {
			continue
		}
		for _, moved := range shifts {
			if index >= moved.first && index <= moved.last {
				index += moved.delta
				break
			}
		}
		rows[index] = row
	}
	for _, match := range changes {
		if match[1] != "-" {
			index, _ := strconv.Atoi(match[2])
			rows[index] = match[3]
		}
	}
	return rows
}

// row returns the window and row text a token names, when the token is from
// that window's latest read.
func (w *windowReads) row(token string) (windowKey, string, bool) {
	snapshot, number, ok := strings.Cut(token, ":")
	index, err := strconv.Atoi(number)
	if !ok || err != nil {
		return windowKey{}, "", false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	key, found := w.snapshots[snapshot]
	if !found {
		return windowKey{}, "", false
	}
	current := w.windows[key]
	if current == nil || current.snapshot != snapshot {
		return windowKey{}, "", false
	}
	row, found := current.rows[index]
	return key, row, found
}
