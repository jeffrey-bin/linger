package localtools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBrowserActionResultCarriesItsSnapshot(t *testing.T) {
	workspace := t.TempDir()
	output := filepath.Join(workspace, ".linger", "browser-output", "b87d595fb668b3ba")
	if err := os.MkdirAll(output, 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(name, text string) string {
		path := filepath.Join(output, name)
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	saved := write("page-1.yml", "- button \"Organize\" [ref=e19]\n")
	other := write("page-2.yml", "other page\n")
	// Real files behind the links that point outside this directory.
	outside := []string{filepath.Join(workspace, ".linger", "browser-output", "0000000000000000", "page-2.yml"), filepath.Join(workspace, ".linger", "page.yml")}
	for _, path := range outside {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("outside\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	secret := filepath.Join(t.TempDir(), "secret.yml")
	link := filepath.Join(output, "page-3.yml")
	// On Windows a standard user can supply a one-use fixture: create a private
	// directory and secret.yml containing "secret\n", then have an administrator
	// create prepared-link.yml pointing to secret.yml. Set this variable to the
	// directory; the test moves the link into its own disposable workspace.
	if runtime.GOOS == "windows" && os.Getenv("LINGER_TEST_BROWSER_LINK_ROOT") != "" {
		root := os.Getenv("LINGER_TEST_BROWSER_LINK_ROOT")
		secret = filepath.Join(root, "secret.yml")
		prepared := filepath.Join(root, "prepared-link.yml")
		info, err := os.Lstat(prepared)
		if err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("fixture link: %v", err)
		}
		resolved, err := filepath.EvalSymlinks(prepared)
		if err != nil || !strings.EqualFold(resolved, secret) {
			t.Fatalf("fixture target=%q err=%v", resolved, err)
		}
		if err := os.Rename(prepared, link); err != nil {
			t.Fatal(err)
		}
	} else {
		if err := os.WriteFile(secret, []byte("secret\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(secret, link); err != nil {
			t.Fatal(err)
		}
	}
	inline := func(text string) string {
		result, _ := json.Marshal(map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}})
		var reply struct {
			Content []struct{ Text string } `json:"content"`
		}
		if err := json.Unmarshal(inlineSnapshot(result, workspace, output), &reply); err != nil {
			t.Fatal(err)
		}
		return reply.Content[0].Text
	}

	got := inline("### Ran Playwright code\n```js\nawait page.click();\n```\n### Snapshot\n- [Snapshot](.linger/browser-output/b87d595fb668b3ba/page-1.yml)")
	if !strings.HasSuffix(got, "### Snapshot\n```yaml\n- button \"Organize\" [ref=e19]\n```") {
		t.Fatalf("snapshot was not inlined: %q", got)
	}
	if _, err := os.Stat(saved); !os.IsNotExist(err) {
		t.Fatalf("the inlined snapshot file remains: %v", err)
	}
	// Only the link right under the Snapshot heading, to a regular file in
	// this Operation's directory, is replaced.
	for _, text := range []string{
		"### Result\n- [Snapshot](.linger/browser-output/b87d595fb668b3ba/page-2.yml)",
		"### Snapshot\n- [Snapshot](.linger/browser-output/0000000000000000/page-2.yml)",
		"### Snapshot\n- [Snapshot](.linger/browser-output/b87d595fb668b3ba/../../page.yml)",
		"### Snapshot\n- [Snapshot](.linger/browser-output/b87d595fb668b3ba/page-3.yml)",
	} {
		if got := inline(text); got != text {
			t.Fatalf("link changed: %q", got)
		}
	}
	for _, path := range append(outside, other) {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("a file behind a refused link was removed: %v", err)
		}
	}
	if data, err := os.ReadFile(secret); err != nil || string(data) != "secret\n" {
		t.Fatalf("linked target changed: %v", err)
	}
}
