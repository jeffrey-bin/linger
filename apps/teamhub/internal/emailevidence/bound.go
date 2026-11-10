package emailevidence

import (
	"encoding/json"
	"errors"
	"unicode/utf8"
)

// BoundMessageInputsJSON keeps the message envelope intact while reducing only
// authored bodies to fit the frozen-input document limit.
func BoundMessageInputsJSON(raw []byte, maxBytes int) ([]byte, error) {
	if maxBytes < 2 {
		return nil, errors.New("email evidence document limit is too small")
	}
	var inputs []MessageInput
	if err := json.Unmarshal(raw, &inputs); err != nil {
		return nil, errors.New("email evidence document is invalid")
	}
	encoded, err := json.Marshal(inputs)
	if err != nil {
		return nil, err
	}
	if len(encoded) <= maxBytes {
		return encoded, nil
	}
	maxBodyBytes := 0
	for _, input := range inputs {
		maxBodyBytes = max(maxBodyBytes, len(input.Body))
	}
	low, high := 0, maxBodyBytes
	var best []byte
	for low <= high {
		bodyLimit := low + (high-low)/2
		candidate := marshalWithBodyLimit(inputs, bodyLimit)
		if len(candidate) <= maxBytes {
			best = candidate
			low = bodyLimit + 1
		} else {
			high = bodyLimit - 1
		}
	}
	if len(best) == 0 {
		return nil, errors.New("email evidence metadata exceeds document limit")
	}
	return best, nil
}

func marshalWithBodyLimit(inputs []MessageInput, bodyLimit int) []byte {
	bounded := append([]MessageInput(nil), inputs...)
	for index := range bounded {
		bounded[index].Body = truncateUTF8Bytes(bounded[index].Body, bodyLimit)
	}
	encoded, _ := json.Marshal(bounded)
	return encoded
}

func truncateUTF8Bytes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(value) <= limit {
		return value
	}
	bounded := value[:limit]
	for bounded != "" && !utf8.ValidString(bounded) {
		bounded = bounded[:len(bounded)-1]
	}
	return bounded
}
