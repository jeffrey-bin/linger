package secretbox

import (
	"bytes"
	"encoding/base64"
	"testing"
)

func TestSealOpenRoundTrip(t *testing.T) {
	box, err := New(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := box.Seal([]byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("secret")) {
		t.Fatal("sealed value contains the plaintext")
	}
	opened, err := box.Open(sealed)
	if err != nil || string(opened) != "secret" {
		t.Fatalf("Open() = %q, %v", opened, err)
	}
	sealed[len(sealed)-1] ^= 1
	if _, err := box.Open(sealed); err == nil {
		t.Fatal("Open() accepted a modified value")
	}
}

func TestNewRejectsWrongKeySize(t *testing.T) {
	for _, key := range []string{"", "not base64", base64.StdEncoding.EncodeToString([]byte("short"))} {
		if _, err := New(key); err == nil {
			t.Fatalf("New(%q) accepted an invalid key", key)
		}
	}
}
