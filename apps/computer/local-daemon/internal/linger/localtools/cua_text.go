package localtools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	// The window screenshot is PNG or JPEG.
	_ "image/jpeg"
)

// recognizeTextDescription describes the macOS text recognition tool.
const recognizeTextDescription = "Read the text in a window's pixels, such as words inside a picture that the accessibility tree does not have. It recognizes the languages macOS knows, without being told which, and returns one line per run of text with its position as fractions of the window or region: x from the left, y from the top. region crops the window first, in pixels of the window's screenshot. pages reads a picture viewer page by page: after each page it presses next_key (right, down or pagedown) to the window in the background, and reads only the part of the window that changed between pages. It stops early, returning the pages read and why, when a key changes nothing or is refused, or the call's time runs out. It types nothing and keeps the element tokens of your last read."

// recognizePagesMax bounds how many pages one call reads.
const recognizePagesMax = 20

// recognizeNextKeys are the keys that turn a page: they move, never submit.
var recognizeNextKeys = map[string]bool{"right": true, "down": true, "pagedown": true}

// recognizeTextFields are the arguments recognize_text takes.
var recognizeTextFields = map[string]bool{"pid": true, "window_id": true, "region": true, "pages": true, "next_key": true}

// recognizePageSettle is how long a viewer gets to show the next page.
var recognizePageSettle = 700 * time.Millisecond

func recognizeTextSchema() json.RawMessage {
	encoded, _ := json.Marshal(schema(map[string]any{
		"pid":       macPID,
		"window_id": map[string]any{"type": "integer"},
		"region": map[string]any{"type": "object", "description": "Optional part of the window, in screenshot pixels.", "properties": map[string]any{
			"x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"}, "width": map[string]any{"type": "number"}, "height": map[string]any{"type": "number"}}},
		"pages":    map[string]any{"type": "integer", "minimum": 1, "maximum": recognizePagesMax, "description": "How many pages of a picture viewer to read, from the one shown. Needs next_key."},
		"next_key": map[string]any{"type": "string", "enum": []string{"right", "down", "pagedown"}, "description": "The key that shows the next page."},
	}, "pid", "window_id"))
	return encoded
}

// visionScript runs macOS Vision text recognition on each image file named
// by its arguments and prints one JSON object per recognized line, top first,
// with the index of its file. One process loads the recognizer once.
const visionScript = `ObjC.import('Vision');
function run(argv) {
	const lines = [];
	for (let f = 0; f < argv.length; f++) {
		const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[f]), $({}));
		const request = $.VNRecognizeTextRequest.alloc.init;
		request.recognitionLevel = 0;
		request.usesLanguageCorrection = true;
		request.automaticallyDetectsLanguage = true;
		if (!handler.performRequestsError($([request]), null)) throw new Error('text recognition failed');
		for (let i = 0; i < request.results.count; i++) {
			const observation = request.results.objectAtIndex(i);
			const candidate = observation.topCandidates(1).objectAtIndex(0);
			const box = observation.boundingBox;
			lines.push(JSON.stringify({file: f, text: ObjC.unwrap(candidate.string), x: box.origin.x, y: 1 - box.origin.y - box.size.height, confidence: candidate.confidence}));
		}
	}
	return lines.join('\n');
}`

// recognizedLine is one line that Vision returned.
type recognizedLine struct {
	File       int     `json:"file"`
	Text       string  `json:"text"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Confidence float64 `json:"confidence"`
}

// recognizePagingBudget bounds the time one call spends turning pages, so
// the pages it read come back before the Runtime gives up on the call.
var recognizePagingBudget = 30 * time.Second

// recognizeText captures a window as Cua shows it, also while it is covered
// or on another Space, and reads its text with macOS Vision. The capture is a
// display-only read, so the Agent's element tokens stay valid. With pages, a
// movement key between captures turns the pages of a picture viewer, and only
// the part of the window that changed is read, so the text around the viewer
// is not repeated for every page. A paged read sends keys, so the call path
// treats it as input (see paged); a one-page read is a read.
func (c *cuaSession) recognizeText(ctx context.Context, args json.RawMessage, agentChrome bool) (output json.RawMessage, callErr error) {
	// The lease and the review read these fields by their exact names, so a
	// field they would not see is refused rather than decoded.
	var fields map[string]json.RawMessage
	if json.Unmarshal(args, &fields) != nil {
		return nil, fmt.Errorf("recognize_text: arguments are not an object: %w", errNotSent)
	}
	for field := range fields {
		if !recognizeTextFields[field] {
			return nil, fmt.Errorf("recognize_text: unknown argument %q: %w", field, errNotSent)
		}
	}
	var params struct {
		PID    *float64 `json:"pid"`
		Window *float64 `json:"window_id"`
		Region *struct {
			X, Y, Width, Height float64
		} `json:"region"`
		Pages   int    `json:"pages"`
		NextKey string `json:"next_key"`
	}
	if json.Unmarshal(args, &params) != nil || params.PID == nil || params.Window == nil {
		return nil, fmt.Errorf("COMPUTER_TARGET_REQUIRED: recognize_text needs pid and window_id: %w", errNotSent)
	}
	pages := max(params.Pages, 1)
	if pages > recognizePagesMax || (pages > 1 && !recognizeNextKeys[params.NextKey]) {
		return nil, fmt.Errorf("recognize_text: pages is 1 to %d, and more than one page needs next_key right, down or pagedown: %w", recognizePagesMax, errNotSent)
	}
	if err := c.checkDesktop(); err != nil {
		return nil, err
	}
	if err := c.startSession(ctx, "auto"); err != nil {
		return nil, err
	}
	first, refused, err := c.windowPixels(ctx, *params.PID, *params.Window)
	if err != nil || refused != nil {
		return refused, err
	}
	// The region is checked on the first page, before any key is sent.
	region := image.Rectangle{}
	if params.Region != nil {
		region = image.Rect(int(params.Region.X), int(params.Region.Y), int(params.Region.X+params.Region.Width), int(params.Region.Y+params.Region.Height)).Intersect(first.Bounds())
		if region.Empty() {
			return nil, fmt.Errorf("recognize_text: region is outside the %dx%d screenshot: %w", first.Bounds().Dx(), first.Bounds().Dy(), errNotSent)
		}
	}
	shots, changed, note, sent := []image.Image{first}, image.Rectangle{}, "", 0
	defer func() {
		if callErr != nil && sent > 0 {
			callErr = fmt.Errorf("recognize_text: %d %s key(s) were sent, so the viewer may now show page %d: %w", sent, params.NextKey, sent+1, callErr)
		}
	}()
	budget := time.Now().Add(recognizePagingBudget)
	if deadline, ok := ctx.Deadline(); ok && deadline.Add(-10*time.Second).Before(budget) {
		budget = deadline.Add(-10 * time.Second)
	}
	for page := 1; page < pages; page++ {
		if time.Now().Add(recognizePageSettle).After(budget) {
			note = fmt.Sprintf("\nStopped after page %d: the time for one call ran out; read the next pages in another call.", page)
			break
		}
		var pressed json.RawMessage
		if agentChrome {
			pressed, err = c.agentChromeKey(ctx, int(*params.PID), *params.Window, "press_key", map[string]any{"key": params.NextKey})
		} else {
			pressed, err = c.client.request(ctx, "tools/call", map[string]any{"name": "press_key", "arguments": map[string]any{
				"pid": *params.PID, "window_id": *params.Window, "key": params.NextKey, "session": c.label}})
		}
		if err != nil {
			sent++
			return nil, err
		}
		if failed(pressed) {
			note = fmt.Sprintf("\nStopped after page %d: the %s key was refused: %s", page, params.NextKey, strings.TrimSpace(string(pressed)))
			break
		}
		sent++
		if err := sleepContext(ctx, recognizePageSettle); err != nil {
			return nil, err
		}
		shot, refused, err := c.windowPixels(ctx, *params.PID, *params.Window)
		if err != nil {
			return nil, err
		}
		if refused != nil {
			note = fmt.Sprintf("\nStopped after page %d: the window could not be read after the %s key: %s", page, params.NextKey, strings.TrimSpace(string(refused)))
			break
		}
		if shot.Bounds() != first.Bounds() {
			note = fmt.Sprintf("\nStopped after page %d: the window changed size after the %s key, so its pages cannot be compared.", page, params.NextKey)
			break
		}
		area := changedArea(shots[len(shots)-1], shot)
		if area.Empty() {
			note = fmt.Sprintf("\nStopped after page %d: the %s key changed nothing.", page, params.NextKey)
			break
		}
		changed = changed.Union(area)
		shots = append(shots, shot)
	}
	area := region
	if area.Empty() && len(shots) > 1 {
		area = changed
	}
	encoded := make([][]byte, len(shots))
	for i, shot := range shots {
		if encoded[i], err = encodeArea(shot, area); err != nil {
			return nil, err
		}
	}
	lines, err := visionText(ctx, encoded)
	if err != nil {
		return nil, err
	}
	var text strings.Builder
	switch {
	case len(shots) == 1:
		fmt.Fprintf(&text, "%d line(s) of text in window %v:", len(lines), *params.Window)
	case params.Region != nil:
		fmt.Fprintf(&text, "%d page(s) of window %v, read in the given region:", len(shots), *params.Window)
	default:
		fmt.Fprintf(&text, "%d page(s) of window %v, read in the area that changed between pages (x=%d y=%d %dx%d screenshot pixels):", len(shots), *params.Window, area.Min.X, area.Min.Y, area.Dx(), area.Dy())
	}
	for page := range shots {
		if len(shots) > 1 {
			fmt.Fprintf(&text, "\n## Page %d", page+1)
		}
		for _, line := range lines {
			if line.File != page {
				continue
			}
			fmt.Fprintf(&text, "\n- x=%.2f y=%.2f %q", line.X, line.Y, line.Text)
			if line.Confidence < 0.5 {
				text.WriteString(" (unsure)")
			}
		}
	}
	text.WriteString(note)
	return json.Marshal(map[string]any{"content": []any{map[string]string{"type": "text", "text": text.String()}}})
}

// pagedRead reports whether a recognize_text call turns pages, and so sends
// keys to the window.
func pagedRead(args json.RawMessage) bool {
	var params struct {
		Pages int `json:"pages"`
	}
	return json.Unmarshal(args, &params) == nil && params.Pages > 1
}

// windowPixels captures window as a display-only read and decodes it. A
// refusal from Cua comes back as the result to return.
func (c *cuaSession) windowPixels(ctx context.Context, pid, window float64) (image.Image, json.RawMessage, error) {
	shot, err := c.client.request(ctx, "tools/call", map[string]any{"name": "get_window_state", "arguments": map[string]any{
		"pid": pid, "window_id": window, "include_accessibility_tree": false, "display_only": true, "session": c.label}})
	if err != nil {
		return nil, nil, err
	}
	var reply struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type string `json:"type"`
			Data string `json:"data"`
		} `json:"content"`
	}
	if err := json.Unmarshal(shot, &reply); err != nil {
		return nil, nil, fmt.Errorf("recognize_text: unreadable window state: %w", err)
	}
	if reply.IsError {
		return nil, shot, nil
	}
	for _, item := range reply.Content {
		if item.Type == "image" {
			pixels, err := base64.StdEncoding.DecodeString(item.Data)
			if err != nil {
				return nil, nil, errors.New("recognize_text: the window screenshot is not base64")
			}
			picture, _, err := image.Decode(bytes.NewReader(pixels))
			if err != nil {
				return nil, nil, fmt.Errorf("recognize_text: decode the screenshot: %w", err)
			}
			return picture, nil, nil
		}
	}
	return nil, nil, errors.New("COMPUTER_WINDOW_UNREADABLE: the window has no screenshot to read")
}

// changedArea returns the bounding box of the pixels that differ between two
// screenshots of one size, or an empty rectangle when they match. Small color
// noise does not count as a change.
func changedArea(before, after image.Image) image.Rectangle {
	area := image.Rectangle{}
	bounds := before.Bounds()
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			r1, g1, b1, _ := before.At(x, y).RGBA()
			r2, g2, b2, _ := after.At(x, y).RGBA()
			if absDiff(r1, r2)+absDiff(g1, g2)+absDiff(b1, b2) > 3*0x1800 {
				area = area.Union(image.Rect(x, y, x+1, y+1))
			}
		}
	}
	return area
}

func absDiff(a, b uint32) uint32 {
	if a > b {
		return a - b
	}
	return b - a
}

// encodeArea returns the part of picture inside area as PNG, or all of it
// when area is empty.
func encodeArea(picture image.Image, area image.Rectangle) ([]byte, error) {
	if !area.Empty() {
		part, ok := picture.(interface {
			SubImage(image.Rectangle) image.Image
		})
		if !ok {
			return nil, errors.New("recognize_text: the screenshot cannot be cropped")
		}
		picture = part.SubImage(area)
	}
	var out bytes.Buffer
	if err := png.Encode(&out, picture); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// visionText runs visionScript on each image in a private temporary
// directory that is removed afterwards. A line's File is the index of its
// image.
var visionText = func(ctx context.Context, images [][]byte) ([]recognizedLine, error) {
	directory, err := os.MkdirTemp("", "linger-text-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(directory)
	arguments := []string{"-l", "JavaScript", "-e", visionScript}
	for i, pixels := range images {
		path := filepath.Join(directory, fmt.Sprintf("page-%d.png", i))
		if err := os.WriteFile(path, pixels, 0o600); err != nil {
			return nil, err
		}
		arguments = append(arguments, path)
	}
	output, err := exec.CommandContext(ctx, "/usr/bin/osascript", arguments...).Output()
	if err != nil {
		return nil, fmt.Errorf("recognize_text: macOS text recognition failed: %w", err)
	}
	var lines []recognizedLine
	for _, row := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		var line recognizedLine
		if row != "" && json.Unmarshal([]byte(row), &line) == nil && line.Text != "" {
			lines = append(lines, line)
		}
	}
	return lines, nil
}
