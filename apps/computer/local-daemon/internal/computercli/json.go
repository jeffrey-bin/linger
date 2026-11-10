package computercli

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

// object is a JSON object that keeps the key order it was decoded or built in,
// so command output repeats the Daemon's fields as they arrived.
type object []member

type member struct {
	key   string
	value json.RawMessage
}

func decodeObject(data []byte) (object, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errors.New("Computer daemon control response is invalid")
	}
	result := object{}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		result = result.with(key.(string), value)
	}
	return result, nil
}

func decodeObjects(data []byte) ([]object, error) {
	var values []json.RawMessage
	if err := json.Unmarshal(data, &values); err != nil {
		return nil, errors.New("Computer daemon control response is invalid")
	}
	result := make([]object, 0, len(values))
	for _, value := range values {
		item, err := decodeObject(value)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}

func (o object) get(key string) (json.RawMessage, bool) {
	for _, item := range o {
		if item.key == key {
			return item.value, true
		}
	}
	return nil, false
}

// with sets key in place, or appends it.
func (o object) with(key string, value any) object {
	encoded, ok := value.(json.RawMessage)
	if !ok {
		encoded, _ = json.Marshal(value)
	}
	result := append(object(nil), o...)
	for index := range result {
		if result[index].key == key {
			result[index].value = encoded
			return result
		}
	}
	return append(result, member{key: key, value: encoded})
}

func (o object) MarshalJSON() ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, item := range o {
		if index > 0 {
			buffer.WriteByte(',')
		}
		key, _ := json.Marshal(item.key)
		buffer.Write(key)
		buffer.WriteByte(':')
		buffer.Write(item.value)
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

func (o object) string(key string) (string, bool) {
	raw, ok := o.get(key)
	if !ok {
		return "", false
	}
	var value string
	return value, json.Unmarshal(raw, &value) == nil
}

func (o object) integer(key string) (int, bool) {
	raw, ok := o.get(key)
	if !ok {
		return 0, false
	}
	value, err := strconv.ParseInt(string(raw), 10, 64)
	return int(value), err == nil && value >= -1<<53 && value <= 1<<53
}

func (o object) boolean(key string) bool {
	raw, _ := o.get(key)
	return string(raw) == "true"
}

// text renders a field for display: strings bare, other values as JSON, and
// a missing field as "undefined".
func (o object) text(key string) string {
	raw, ok := o.get(key)
	if !ok {
		return "undefined"
	}
	return rawText(raw)
}

// textOr renders key, or fallback when the field is missing or null.
func (o object) textOr(key, fallback string) string {
	raw, ok := o.get(key)
	if !ok || string(raw) == "null" {
		return fallback
	}
	return rawText(raw)
}

func rawText(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return value
	}
	var compact bytes.Buffer
	if json.Compact(&compact, raw) == nil {
		return compact.String()
	}
	return strings.TrimSpace(string(raw))
}

// marshalReport renders a report like the CLI's other JSON output: two-space
// indentation, no HTML escaping, and a final newline.
func marshalReport(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(value)
	return buffer.String()
}
