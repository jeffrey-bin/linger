package voicemedia

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func writeStagingFile(t *testing.T, root, key string) {
	t.Helper()
	target := filepath.Join(root, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(key), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLocalStagingStoreListsOneEpochInKeyOrder(t *testing.T) {
	root := t.TempDir()
	for _, key := range []string{
		"voice-staging/capture_a/epoch-1_00001.ts",
		"voice-staging/capture_a/epoch-1_00000.ts",
		"voice-staging/capture_a/epoch-1.m3u8",
		// epoch-10 shares the text prefix of epoch-1 and stays out of its list.
		"voice-staging/capture_a/epoch-10_00000.ts",
		"voice-staging/capture_a/.upload-123",
	} {
		writeStagingFile(t, root, key)
	}
	staging := NewLocalStagingStore(nil, root)
	keys, err := staging.List(t.Context(), "voice-staging/capture_a/epoch-1", "")
	want := []string{
		"voice-staging/capture_a/epoch-1.m3u8",
		"voice-staging/capture_a/epoch-1_00000.ts",
		"voice-staging/capture_a/epoch-1_00001.ts",
	}
	if err != nil || !reflect.DeepEqual(keys, want) {
		t.Fatalf("keys=%v err=%v", keys, err)
	}
	keys, err = staging.List(t.Context(), "voice-staging/capture_a/epoch-1", "voice-staging/capture_a/epoch-1_00000")
	if err != nil || !reflect.DeepEqual(keys, want[1:]) {
		t.Fatalf("keys after cursor=%v err=%v", keys, err)
	}
	keys, err = staging.List(t.Context(), "voice-staging/capture_missing/epoch-0", "")
	if err != nil || len(keys) != 0 {
		t.Fatalf("missing epoch keys=%v err=%v", keys, err)
	}
	reader, err := staging.Open(t.Context(), want[1])
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || string(body) != want[1] {
		t.Fatalf("body=%q err=%v", body, err)
	}
	if _, err = staging.Open(t.Context(), "voice-staging/capture_a/../../escape.ts"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("escaping key opened: %v", err)
	}
}

func TestLocalStagingStoreDeletePrefixRemovesOnlyThatCapture(t *testing.T) {
	root := t.TempDir()
	// capture_a_10 shares the text prefix of capture_a_1.
	writeStagingFile(t, root, "voice-staging/capture_a_1/epoch-0_00000.ts")
	writeStagingFile(t, root, "voice-staging/capture_a_1/epoch-0.m3u8")
	writeStagingFile(t, root, "voice-staging/capture_a_10/epoch-0_00000.ts")
	staging := NewLocalStagingStore(nil, root)
	for range 2 {
		// A retry finds nothing left and succeeds.
		if err := staging.DeletePrefix(t.Context(), "voice-staging/capture_a_1/"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "voice-staging", "capture_a_1")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted Capture staging remains: %v", err)
	}
	keys, err := staging.List(t.Context(), "voice-staging/capture_a_10/epoch-0", "")
	if err != nil || len(keys) != 1 {
		t.Fatalf("other Capture keys=%v err=%v", keys, err)
	}
	if err := staging.DeletePrefix(t.Context(), "voice-staging/"); !errors.Is(err, ErrRecordingInvalid) {
		t.Fatalf("broad prefix accepted: %v", err)
	}
}
