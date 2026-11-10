package account

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"strings"
	"testing"
)

func TestImageValidationAndPatch(t *testing.T) {
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	valid := "data:image/png;base64," + base64.StdEncoding.EncodeToString(buffer.Bytes())
	for _, input := range []string{"", valid} {
		if !validProfileImage(input) {
			t.Fatal("valid image rejected")
		}
	}
	for _, input := range []string{"https://example.com/photo.png", "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,bm90LWFuLWltYWdl", strings.Replace(valid, "image/png", "image/jpeg", 1), strings.Repeat("a", 524289)} {
		if validProfileImage(input) {
			t.Fatal("invalid image accepted")
		}
	}
	next, err := applyPatch(record{Name: "Alice", Bio: "Keep bio"}, Patch{AvatarImage: &valid, BackgroundImage: &valid})
	if err != nil || next.AvatarImage != valid || next.BackgroundImage != valid || next.Bio != "Keep bio" {
		t.Fatalf("patch failed: %v", err)
	}
	empty := ""
	cleared, err := applyPatch(next, Patch{AvatarImage: &empty})
	if err != nil || cleared.AvatarImage != "" || cleared.BackgroundImage != valid {
		t.Fatal("clearing avatar changed background")
	}
}
