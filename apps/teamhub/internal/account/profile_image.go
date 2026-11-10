package account

import (
	"bytes"
	"encoding/base64"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"strings"
)

// Profile images are bounded thumbnails, stored with their owner-scoped profile.
func validProfileImage(value string) bool {
	if value == "" {
		return true
	}
	if len(value) > 524288 {
		return false
	}
	header, encoded, ok := strings.Cut(value, ",")
	if !ok || (header != "data:image/jpeg;base64" && header != "data:image/png;base64") {
		return false
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return false
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 2048 || config.Height > 2048 {
		return false
	}
	if header != "data:image/"+format+";base64" {
		return false
	}
	_, _, err = image.Decode(bytes.NewReader(data))
	return err == nil
}
