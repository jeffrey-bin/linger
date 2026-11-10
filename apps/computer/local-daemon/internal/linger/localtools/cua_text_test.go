package localtools

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestEncodeAreaCropsToTheArea(t *testing.T) {
	picture := image.NewRGBA(image.Rect(0, 0, 40, 30))
	for _, test := range []struct {
		area          image.Rectangle
		width, height int
	}{
		{image.Rect(30, 20, 40, 30), 10, 10},
		{image.Rectangle{}, 40, 30},
	} {
		encoded, err := encodeArea(picture, test.area)
		if err != nil {
			t.Fatal(err)
		}
		part, err := png.Decode(bytes.NewReader(encoded))
		if err != nil || part.Bounds().Dx() != test.width || part.Bounds().Dy() != test.height {
			t.Fatalf("%v: bounds=%v err=%v", test.area, part.Bounds(), err)
		}
	}
}

func TestChangedAreaBoundsTheDifferingPixels(t *testing.T) {
	blank := image.NewRGBA(image.Rect(0, 0, 40, 30))
	page := image.NewRGBA(blank.Bounds())
	page.Set(5, 6, color.White)
	page.Set(20, 12, color.White)
	if got := changedArea(blank, page); got != image.Rect(5, 6, 21, 13) {
		t.Fatalf("area = %v", got)
	}
	// Faint noise is not a new page.
	noise := image.NewRGBA(blank.Bounds())
	noise.Set(5, 6, color.RGBA{8, 8, 8, 255})
	if got := changedArea(blank, noise); !got.Empty() {
		t.Fatalf("noise area = %v", got)
	}
}
