package localtools

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func windowPNG(t *testing.T) string {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 320, 200))
	for y := range 200 {
		for x := range 320 {
			picture.Set(x, y, color.RGBA{R: uint8(x * y), G: uint8(x ^ y), B: uint8(x + y), A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, picture); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buffer.Bytes())
}

func TestCompactScreenshotsReencodesPNGAsJPEGOfTheSameSize(t *testing.T) {
	encoded := windowPNG(t)
	result, _ := json.Marshal(map[string]any{
		"content": []any{
			map[string]string{"type": "text", "text": "size=320x200 snapshot_id=s1"},
			map[string]string{"type": "image", "mimeType": "image/png", "data": encoded},
		},
		"structuredContent": map[string]any{"snapshot_id": "s1"},
	})
	var reply struct {
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			MimeType string `json:"mimeType"`
			Data     string `json:"data"`
		} `json:"content"`
		Structured map[string]any `json:"structuredContent"`
	}
	if err := json.Unmarshal(compactScreenshots(result), &reply); err != nil {
		t.Fatal(err)
	}
	if len(reply.Content) != 2 || reply.Content[0].Text != "size=320x200 snapshot_id=s1" || reply.Structured["snapshot_id"] != "s1" {
		t.Fatalf("result shape changed: %+v", reply)
	}
	picture := reply.Content[1]
	if picture.Type != "image" || picture.MimeType != "image/jpeg" {
		t.Fatalf("screenshot = %s %s", picture.Type, picture.MimeType)
	}
	raw, err := base64.StdEncoding.DecodeString(picture.Data)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Bounds() != image.Rect(0, 0, 320, 200) {
		t.Fatalf("dimensions changed: %v", decoded.Bounds())
	}
	if len(picture.Data) >= len(encoded) {
		t.Fatalf("JPEG (%d) is not smaller than PNG (%d)", len(picture.Data), len(encoded))
	}
}

func TestCompactScreenshotsLeavesOtherResultsAlone(t *testing.T) {
	for _, result := range []string{
		`{"content":[{"type":"text","text":"- [0] AXWindow"}],"structuredContent":{"snapshot_id":"s2"}}`,
		`{"content":[{"type":"image","mimeType":"image/jpeg","data":"already"}]}`,
		`{"content":[{"type":"image","mimeType":"image/png","data":"not base64 png"}]}`,
		`{"isError":true,"content":[]}`,
	} {
		if got := string(compactScreenshots(json.RawMessage(result))); got != result {
			t.Fatalf("result changed:\n%s\n%s", result, got)
		}
	}
}
