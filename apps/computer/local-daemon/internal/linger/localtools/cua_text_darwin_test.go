package localtools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// pagedReadSession stubs the lock screen check and Vision, and reports the
// size of each image Vision was given.
func pagedReadSession(t *testing.T, mode string) (*cuaSession, string, *[]image.Rectangle) {
	t.Helper()
	locked, vision, settle := screenLocked, visionText, recognizePageSettle
	t.Cleanup(func() { screenLocked, visionText, recognizePageSettle = locked, vision, settle })
	screenLocked = func() bool { return false }
	recognizePageSettle = 0
	var sizes []image.Rectangle
	visionText = func(_ context.Context, images [][]byte) ([]recognizedLine, error) {
		lines := []recognizedLine{}
		for i, encoded := range images {
			picture, err := png.Decode(bytes.NewReader(encoded))
			if err != nil {
				return nil, err
			}
			sizes = append(sizes, picture.Bounds())
			lines = append(lines, recognizedLine{File: i, Text: "page text", Confidence: 1})
		}
		return lines, nil
	}
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	return cuaFixtureSession(t, mode, marker), marker, &sizes
}

func TestRecognizeTextReadsPagesUntilAKeyChangesNothing(t *testing.T) {
	c, marker, sizes := pagedReadSession(t, "pages")
	result, err := c.call(t.Context(), "recognize_text", json.RawMessage(`{"pid":42,"window_id":9,"pages":5,"next_key":"right"}`))
	if err != nil {
		t.Fatal(err)
	}
	text := string(result)
	// Pages 1-3 differ; the third key changes nothing, so a fourth is never read.
	if !strings.Contains(text, "3 page(s)") || !strings.Contains(text, "## Page 3") || !strings.Contains(text, "Stopped after page 3: the right key changed nothing") {
		t.Fatalf("result = %s", text)
	}
	// Only the changed pixels, from (10,6) to (14,6), are read on each page.
	if len(*sizes) != 3 || (*sizes)[0].Dx() != 5 || (*sizes)[0].Dy() != 1 || !strings.Contains(text, "x=10 y=6 5x1") {
		t.Fatalf("Vision images = %v", *sizes)
	}
	if calls := fixtureCalls(t, marker); len(calls) != 3 {
		t.Fatalf("keys sent = %v, want 3", calls)
	}
}

func TestRecognizeTextKeepsThePagesReadBeforeARefusedKey(t *testing.T) {
	c, _, sizes := pagedReadSession(t, "pages-refused")
	result, err := c.call(t.Context(), "recognize_text", json.RawMessage(`{"pid":42,"window_id":9,"pages":5,"next_key":"right"}`))
	if err != nil {
		t.Fatal(err)
	}
	if text := string(result); !strings.Contains(text, "2 page(s)") || !strings.Contains(text, "Stopped after page 2: the right key was refused") || len(*sizes) != 2 {
		t.Fatalf("result = %s, images %v", text, *sizes)
	}
}

func TestRecognizeTextChecksTheRegionBeforeAnyKey(t *testing.T) {
	c, marker, _ := pagedReadSession(t, "pages")
	_, err := c.call(t.Context(), "recognize_text", json.RawMessage(`{"pid":42,"window_id":9,"pages":5,"next_key":"right","region":{"x":100,"y":100,"width":5,"height":5}}`))
	if !errors.Is(err, errNotSent) || len(fixtureCalls(t, marker)) != 0 {
		t.Fatalf("err = %v, keys %v", err, fixtureCalls(t, marker))
	}
	// A region inside the window is read as given on every page.
	c, _, sizes := pagedReadSession(t, "pages")
	result, err := c.call(t.Context(), "recognize_text", json.RawMessage(`{"pid":42,"window_id":9,"pages":2,"next_key":"right","region":{"x":0,"y":0,"width":20,"height":10}}`))
	if err != nil || !strings.Contains(string(result), "read in the given region") || len(*sizes) != 2 || (*sizes)[1] != image.Rect(0, 0, 20, 10) {
		t.Fatalf("result = %s err=%v images %v", result, err, *sizes)
	}
}

func TestRecognizeTextStopsPagingWhenTheBudgetRunsOut(t *testing.T) {
	c, marker, _ := pagedReadSession(t, "pages")
	budget := recognizePagingBudget
	t.Cleanup(func() { recognizePagingBudget = budget })
	recognizePagingBudget = -time.Second
	result, err := c.call(t.Context(), "recognize_text", json.RawMessage(`{"pid":42,"window_id":9,"pages":5,"next_key":"right"}`))
	if err != nil || !strings.Contains(string(result), "the time for one call ran out") || len(fixtureCalls(t, marker)) != 0 {
		t.Fatalf("result = %s err=%v", result, err)
	}
}

func TestRecognizeTextRecordsAnUnknownKeyOutcome(t *testing.T) {
	c, marker, _ := pagedReadSession(t, "pages-hang")
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		_, err := c.call(ctx, "recognize_text", json.RawMessage(`{"pid":42,"window_id":9,"pages":3,"next_key":"right"}`))
		done <- err
	}()
	for deadline := time.Now().Add(5 * time.Second); len(fixtureCalls(t, marker)) == 0; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the key was not sent")
		}
	}
	cancel()
	err := <-done
	if !errors.Is(err, errOutcomeUnknown) || !strings.Contains(err.Error(), "1 right key(s) were sent") {
		t.Fatalf("err = %v, want an unknown outcome that names the key sent", err)
	}
	if !c.op.manager.journal.blocked() {
		t.Fatal("a key with an unknown outcome left the journal open for new input")
	}
}

func TestRecognizeTextRefusesFieldsTheReviewDoesNotRead(t *testing.T) {
	c, marker, _ := pagedReadSession(t, "pages")
	_, err := c.call(t.Context(), "recognize_text", json.RawMessage(`{"pid":42,"window_id":9,"pages":3,"next_key":"right","PID":7}`))
	if !errors.Is(err, errNotSent) || len(fixtureCalls(t, marker)) != 0 {
		t.Fatalf("err = %v, keys %v", err, fixtureCalls(t, marker))
	}
}
