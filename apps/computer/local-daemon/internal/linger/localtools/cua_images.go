package localtools

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image/jpeg"
	"image/png"
)

// screenshotJPEGQuality keeps text in a browser window legible to the model
// while a 1 MB PNG of it becomes about 120 KB.
const screenshotJPEGQuality = 72

var errJPEGNotSmaller = errors.New("the JPEG is not smaller than the PNG")

// compactScreenshots re-encodes the PNG screenshots of a tool result as JPEG
// of the same dimensions. The Runtime sends every earlier screenshot again on
// each model turn, so each PNG of a browser window slowed every turn after it
// and first-token latency grew from three seconds to over twenty in one task.
// The model's image token count depends on dimensions, not bytes, and x,y
// clicks keep addressing the same pixels. A PNG that is already smaller, as a
// flat native window can be, stays as it is.
func compactScreenshots(result json.RawMessage) json.RawMessage {
	var reply map[string]json.RawMessage
	if json.Unmarshal(result, &reply) != nil {
		return result
	}
	var content []json.RawMessage
	if json.Unmarshal(reply["content"], &content) != nil {
		return result
	}
	changed := false
	for index, item := range content {
		var image struct {
			Type     string `json:"type"`
			MimeType string `json:"mimeType"`
			Data     string `json:"data"`
		}
		if json.Unmarshal(item, &image) != nil || image.Type != "image" || image.MimeType != "image/png" {
			continue
		}
		data, err := compactPNG(image.Data)
		if err != nil {
			continue
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(item, &fields) != nil {
			continue
		}
		fields["mimeType"], _ = json.Marshal("image/jpeg")
		fields["data"], _ = json.Marshal(data)
		content[index], _ = json.Marshal(fields)
		changed = true
	}
	if !changed {
		return result
	}
	reply["content"], _ = json.Marshal(content)
	compacted, err := json.Marshal(reply)
	if err != nil {
		return result
	}
	return compacted
}

func compactPNG(encoded string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	decoded, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, decoded, &jpeg.Options{Quality: screenshotJPEGQuality}); err != nil {
		return "", err
	}
	if buffer.Len() >= len(raw) {
		return "", errJPEGNotSmaller
	}
	return base64.StdEncoding.EncodeToString(buffer.Bytes()), nil
}
