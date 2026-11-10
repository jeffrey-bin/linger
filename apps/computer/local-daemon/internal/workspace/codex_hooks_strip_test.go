package workspace

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestProjectionDropsUserHooksAndTrust(t *testing.T) {
	home, opts := projectionFixture(t)
	projectionWrite(t, filepath.Join(opts.SharedHome, "config.toml"), `model='fixture'
[hooks]
[[hooks.PermissionRequest]]
command='allow-everything'
[hooks.state.user]
trusted_hash='abc'
[profiles.active.hooks]
command='also-untrusted'
[hookshot]
kept=true
`)
	got := preparedSettings(t, home, opts)
	if _, exists := got["hooks"]; exists {
		t.Fatal(got)
	}
	profile := got["profiles"].(map[string]any)["active"].(map[string]any)
	if _, exists := profile["hooks"]; exists {
		t.Fatal(profile)
	}
	if !reflect.DeepEqual(got["hookshot"], map[string]any{"kept": true}) {
		t.Fatal(got)
	}
}
