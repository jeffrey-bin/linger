package secretbox

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

type signedPayload struct {
	Name string `json:"n"`
}

func TestSignVerifyRoundTripAndRejections(t *testing.T) {
	key := []byte("test-key")
	value, err := Sign(key, "test/v1", signedPayload{Name: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(value, "/") {
		t.Fatalf("signed value %q must stay one path segment", value)
	}
	var got signedPayload
	if !Verify(key, "test/v1", value, &got) || got.Name != "alice" {
		t.Fatalf("Verify(signed)=%+v", got)
	}
	encoded, mac, _ := strings.Cut(value, ".")
	forged, _ := json.Marshal(signedPayload{Name: "mallory"})
	for name, candidate := range map[string]string{
		"tampered payload": base64.RawURLEncoding.EncodeToString(forged) + "." + mac,
		"tampered mac":     encoded + "." + base64.RawURLEncoding.EncodeToString([]byte("not the mac")),
		"no separator":     encoded,
		"extra segment":    value + ".x",
		"oversized":        strings.Repeat("a", MaxSignedLength+1),
	} {
		if Verify(key, "test/v1", candidate, &got) {
			t.Errorf("%s verified", name)
		}
	}
	if Verify([]byte("other-key"), "test/v1", value, &got) {
		t.Error("value verified under another key")
	}
	if Verify(key, "test/v2", value, &got) {
		t.Error("value verified under another domain")
	}
	// JSON escapes "<" as six bytes, so a short name can still overflow.
	if _, err := Sign(key, "test/v1", signedPayload{Name: strings.Repeat("<", 300)}); !errors.Is(err, ErrTooLong) {
		t.Errorf("Sign(oversized)=%v, want ErrTooLong", err)
	}
	if Verify(nil, "test/v1", value, &got) {
		t.Error("value verified without a key")
	}
}
