package privatefs

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPrivateFileRoundTripReplacementAndExclusiveCreation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "identité.json")
	if err := WriteFile(path, []byte("first"), true); err != nil {
		t.Fatal(err)
	}
	if err := CheckPath(path, "file", true); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("overwrite"), true); !errors.Is(err, os.ErrExist) {
		t.Fatalf("exclusive overwrite=%v", err)
	}
	if err := WriteFile(path, []byte("second"), false); err != nil {
		t.Fatal(err)
	}
	data, err := ReadFile(path, 6)
	if err != nil || string(data) != "second" {
		t.Fatalf("data=%q err=%v", data, err)
	}
	if _, err := ReadFile(path, 5); err == nil {
		t.Fatal("size limit ignored")
	}
}
func TestPrivateFileRejectsHardLinks(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "secret")
	link := filepath.Join(root, "alias")
	if err := WriteFile(path, []byte("secret"), true); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFile(path, 0); err == nil {
		t.Fatal("hardline credential accepted")
	}
	if err := WriteFile(link, []byte("changed"), false); err == nil {
		t.Fatal("hardlink replacement accepted")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "secret" {
		t.Fatalf("original changed: %q %v", data, err)
	}
}
