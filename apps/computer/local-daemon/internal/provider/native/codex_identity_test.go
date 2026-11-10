//go:build !windows

package native

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexAuthFingerprintIgnoresTokenRefresh(t *testing.T) {
	home := t.TempDir()
	write := func(text string) string {
		if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		return codexAuthFingerprint(home)
	}
	if codexAuthFingerprint("") != "" || codexAuthFingerprint(home) != "" {
		t.Fatal("no home or no file must give the empty fingerprint")
	}
	base := write(`{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"account_id":"acct-a","access_token":"a1","refresh_token":"r1"}}`)
	if base == "" {
		t.Fatal("empty fingerprint for a readable file")
	}
	if got := write(`{"tokens":{"refresh_token":"r2","access_token":"a2","account_id":"acct-a"},"auth_mode":"chatgpt","last_refresh":"now"}`); got != base {
		t.Fatal("a token refresh changed the fingerprint")
	}
	if got := write(`{"auth_mode":"chatgpt","tokens":{"account_id":"acct-b"}}`); got == base {
		t.Fatal("an account change kept the fingerprint")
	}
	if write(`{"tokens":{}}`) != write(`{"tokens":{"account_id":null},"auth_mode":null}`) {
		t.Fatal("absent and null must count as equal")
	}
	if write(`not json`) == write(`not json!`) {
		t.Fatal("unparsable files must hash their bytes")
	}
}

func writeSkill(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// codexTwoTurns runs a turn, applies change, then runs a resume turn, and
// returns the launch count. Each turn opens the runtime anew, as the
// Executor does, so a change to the fake's delivered digests takes effect.
func codexTwoTurns(t *testing.T, fake *codexFake, change func()) int {
	t.Helper()
	return codexTwoTurnsLogged(t, fake, nil, change)
}

func codexTwoTurnsLogged(t *testing.T, fake *codexFake, log *codexTestLog, change func()) int {
	t.Helper()
	runtime := func() Runtime {
		if log == nil {
			return fake.runtime(nil)
		}
		return fake.runtime(log.logger())
	}
	spec := fake.spec()
	out, _ := codexDrain(t, runtime(), "one", spec)
	if out.Status != statusCompleted || out.ExitConfirmed {
		t.Fatalf("first = %+v", out)
	}
	change()
	spec.ResumeID = out.SessionID
	if out, _ := codexDrain(t, runtime(), "two", spec); out.Status != statusCompleted {
		t.Fatalf("second = %+v", out)
	}
	return fake.launchCount()
}

func TestCodexCredentialsChangeRecycles(t *testing.T) {
	const accountA = `{"auth_mode":"chatgpt","tokens":{"account_id":"acct-a","access_token":"a1","refresh_token":"r1"}}`
	cases := []struct {
		name     string
		next     string
		launches int
	}{
		{"token refresh", `{"auth_mode":"chatgpt","tokens":{"account_id":"acct-a","access_token":"a2","refresh_token":"r2"}}`, 1},
		{"account change", `{"auth_mode":"chatgpt","tokens":{"account_id":"acct-b","access_token":"b1"}}`, 2},
		{"api key", `{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test"}`, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := newCodexFake(t, nil, nil)
			auth := filepath.Join(fake.home, "auth.json")
			if err := os.WriteFile(auth, []byte(accountA), 0o600); err != nil {
				t.Fatal(err)
			}
			log := &codexTestLog{}
			rt := fake.runtime(log.logger())
			spec := fake.spec()
			out, _ := codexDrain(t, rt, "one", spec)
			if err := os.WriteFile(auth, []byte(tc.next), 0o600); err != nil {
				t.Fatal(err)
			}
			spec.ResumeID = out.SessionID
			if out, _ := codexDrain(t, rt, "two", spec); out.Status != statusCompleted {
				t.Fatalf("second = %+v", out)
			}
			if got := fake.launchCount(); got != tc.launches {
				t.Fatalf("launches = %d, want %d", got, tc.launches)
			}
			if tc.launches == 2 && !containsAll(log.String(), "codex resident recycled", `"mismatch":"auth"`) {
				t.Fatalf("log = %s", log.String())
			}
		})
	}
}

// The Daemon's delivered Skills and projected configuration decide reuse: a
// changed Skill digest replaces the process, a changed configuration digest
// rebinds the thread on the same process.
func TestCodexDeliveredInputsDecideReuse(t *testing.T) {
	t.Run("skills", func(t *testing.T) {
		fake := newCodexFake(t, nil, nil)
		fake.skillDigest = "skills-a"
		log := &codexTestLog{}
		if got := codexTwoTurnsLogged(t, fake, log, func() { fake.skillDigest = "skills-b" }); got != 2 {
			t.Fatalf("launches = %d", got)
		}
		if !containsAll(log.String(), "codex resident recycled", `"mismatch":"skills"`) {
			t.Fatalf("log = %s", log.String())
		}
	})
	t.Run("configuration", func(t *testing.T) {
		fake := newCodexFake(t, nil, nil)
		fake.configDigest = "config-a"
		if got := codexTwoTurns(t, fake, func() { fake.configDigest = "config-b" }); got != 1 || fake.count("thread/resume") != 1 {
			t.Fatalf("launches = %d methods = %v", got, fake.methods())
		}
	})
}

// Reuse depends only on what the Daemon delivered. Files a Runtime or an
// Agent writes into its own home or workspace never recycle the process.
func TestCodexRuntimeWritesKeepProcess(t *testing.T) {
	cases := map[string]struct {
		env    map[string]string
		change func(f *codexFake)
	}{
		"Codex installs its system Skills": {env: map[string]string{"FAKE_MODES": "write_system_skills"}, change: func(*codexFake) {}},
		"Agent writes a workspace Skill": {change: func(f *codexFake) {
			writeSkill(t, filepath.Join(f.dir, ".agents", "skills", "w"), "W")
		}},
		"Agent writes a home Skill": {change: func(f *codexFake) {
			writeSkill(t, filepath.Join(f.home, "skills", "a"), "A")
		}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			fake := newCodexFake(t, nil, tc.env)
			if got := codexTwoTurns(t, fake, func() { tc.change(fake) }); got != 1 {
				t.Fatalf("launches = %d, want the process reused", got)
			}
		})
	}
}

func containsAll(text string, parts ...string) bool {
	for _, part := range parts {
		if !strings.Contains(text, part) {
			return false
		}
	}
	return true
}
