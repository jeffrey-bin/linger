package workspace

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in native protocol proof: no thread or model request is created.
func TestNativeCodexListsInheritedSkill(t *testing.T) {
	binary := os.Getenv("LINGER_CODEX_SKILL_PROBE")
	if binary == "" {
		t.Skip("set LINGER_CODEX_SKILL_PROBE to an installed Codex executable")
	}
	user := t.TempDir()
	shared := filepath.Join(user, ".codex")
	target := filepath.Join(user, "context")
	path := filepath.Join(shared, "skills", "inherited-proof")
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "SKILL.md"), []byte("---\nname: inherited-proof\ndescription: Native discovery proof\n---\nOnly a fixture.\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareCodexHome(target, CodexHomeOptions{SharedHome: shared, UserHome: user}, slog.Default()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "app-server", "--disable", "plugins", "--listen", "stdio://")
	cmd.Dir = user
	cmd.Env = append(os.Environ(), "CODEX_HOME="+target, "HOME="+user)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); _ = cmd.Wait() }()
	_, _ = fmt.Fprintln(stdin, `{"id":1,"method":"initialize","params":{"clientInfo":{"name":"linger-skill-proof","version":"1"},"capabilities":{"experimentalApi":true}}}`)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 65536), 4*1024*1024)
	for scanner.Scan() {
		var msg struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(scanner.Bytes(), &msg) != nil {
			continue
		}
		if msg.ID == 1 {
			_, _ = fmt.Fprintln(stdin, `{"method":"initialized"}`)
			request, _ := json.Marshal(map[string]any{"id": 2, "method": "skills/list", "params": map[string]any{"cwds": []string{user}, "forceReload": true}})
			_, _ = fmt.Fprintln(stdin, string(request))
		}
		if msg.ID == 2 {
			var result struct {
				Data []struct {
					Skills []struct {
						Name    string `json:"name"`
						Enabled bool   `json:"enabled"`
					}
				} `json:"data"`
			}
			if err := json.Unmarshal(msg.Result, &result); err != nil {
				t.Fatal(err)
			}
			for _, data := range result.Data {
				for _, skill := range data.Skills {
					if skill.Name == "inherited-proof" {
						return
					}
				}
			}
			t.Fatalf("native Codex did not discover the projected Skill: %s", msg.Result)
		}
	}
	t.Fatal("native Codex skills/list did not complete", scanner.Err())
}

func TestCodexInheritedSkillsRespectDisabledAndRefresh(t *testing.T) {
	user := t.TempDir()
	shared := filepath.Join(user, "custom-codex")
	target := filepath.Join(user, "context")
	writeSkill := func(path, name string) {
		t.Helper()
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "SKILL.md"), []byte("---\nname: "+name+"\ndescription: Test skill\n---\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeSkill(filepath.Join(shared, "skills", "off"), "off")
	writeSkill(filepath.Join(user, ".agents", "skills", "user-skill"), "user-skill")
	writeSkill(filepath.Join(shared, "plugins", "cache", "market", "enabled", "v1", "skills", "plugin-skill"), "plugin-skill")
	writeSkill(filepath.Join(shared, "plugins", "cache", "market", "disabled", "v1", "skills", "hidden"), "hidden")
	// Codex unpacks its bundled Skills here; they are not the user's.
	writeSkill(filepath.Join(shared, "skills", ".system", "imagegen"), "imagegen")
	config := "[[skills.config]]\npath = \"skills/off/SKILL.md\"\nenabled = false\n[plugins.\"enabled@market\"]\nenabled = true\n[plugins.\"disabled@market\"]\nenabled = false\n"
	if err := os.WriteFile(filepath.Join(shared, "config.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	skills, err := DiscoverCodexSkills(shared, user)
	if err != nil {
		t.Fatal(err)
	}
	states := map[string]bool{}
	for _, skill := range skills {
		states[skill.Name] = skill.Enabled
	}
	if len(states) != 3 || states["off"] || !states["user-skill"] || !states["plugin-skill"] {
		t.Fatalf("wrong native inventory: %#v", states)
	}
	opts := CodexHomeOptions{SharedHome: shared, UserHome: user}
	if _, err := PrepareCodexHome(target, opts, slog.Default()); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(target, "skills"))
	if err != nil || len(entries) != 2 {
		t.Fatalf("wrong projected skills: %v %v", entries, err)
	}
	projected, _ := os.ReadFile(filepath.Join(target, "config.toml"))
	if !strings.Contains(string(projected), "enabled = false") {
		t.Fatal("disabled rule was lost")
	}
	// Disabling the plugin must remove only the old inherited link on the next Run.
	if err := os.WriteFile(filepath.Join(shared, "config.toml"), []byte(strings.ReplaceAll(config, "enabled = true", "enabled = false")), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareCodexHome(target, opts, slog.Default()); err != nil {
		t.Fatal(err)
	}
	entries, _ = os.ReadDir(filepath.Join(target, "skills"))
	if len(entries) != 1 {
		t.Fatalf("stale plugin Skill remained: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(shared, "plugins", "cache", "market", "enabled", "v1", "skills", "plugin-skill", "SKILL.md")); err != nil {
		t.Fatal("source Skill was modified", err)
	}
}

func TestCodexHomeInheritsSkillsWithoutSharingSessions(t *testing.T) {
	root := t.TempDir()
	shared := filepath.Join(root, ".codex")
	skill := filepath.Join(shared, "skills", "personal")
	if err := os.MkdirAll(skill, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("---\nname: personal\ndescription: Personal skill\n---\nUse my helper.\n"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "context")
	if _, err := PrepareCodexHome(target, CodexHomeOptions{SharedHome: shared}, slog.Default()); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(target, "skills"))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range entries {
		raw, _ := os.ReadFile(filepath.Join(target, "skills", entry.Name(), "SKILL.md"))
		if string(raw) == "---\nname: personal\ndescription: Personal skill\n---\nUse my helper.\n" {
			found = true
		}
	}
	if !found {
		t.Fatal("personal Codex Skill is absent from the Context home")
	}
	if info, err := os.Lstat(filepath.Join(target, "sessions")); err == nil && info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("Session isolation was lost")
	}
}

// The projection digests change only with what the Daemon delivers: files
// Codex writes into its home leave them alone.
func TestCodexProjectionDigestsFollowDeliveredInputs(t *testing.T) {
	user := t.TempDir()
	shared := filepath.Join(user, ".codex")
	target := filepath.Join(user, "context")
	write := func(path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	skill := func(name, description string) string {
		return "---\nname: " + name + "\ndescription: " + description + "\n---\n"
	}
	write(filepath.Join(user, ".agents", "skills", "mine", "SKILL.md"), skill("mine", "First"))
	write(filepath.Join(shared, "config.toml"), "model = \"m\"\n[mcp_servers.own]\ncommand = \"x\"\n")
	opts := CodexHomeOptions{SharedHome: shared, UserHome: user}
	project := func() CodexProjection {
		t.Helper()
		projection, err := PrepareCodexHome(target, opts, slog.Default())
		if err != nil {
			t.Fatal(err)
		}
		return projection
	}
	base := project()
	if again := project(); base.SkillDigest == "" || base.ConfigDigest == "" || again.SkillDigest != base.SkillDigest || again.ConfigDigest != base.ConfigDigest {
		t.Fatalf("digests are not stable: %+v", base)
	}

	// Codex installs its own Skills and writes trust into config.toml.
	write(filepath.Join(target, "skills", ".system", "imagegen", "SKILL.md"), skill("imagegen", "System"))
	appendTo, err := os.OpenFile(filepath.Join(target, "config.toml"), os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = appendTo.WriteString("\n[projects.\"/trusted\"]\ntrust_level = \"trusted\"\n")
	_ = appendTo.Close()
	if got := project(); got.SkillDigest != base.SkillDigest || got.ConfigDigest != base.ConfigDigest {
		t.Fatalf("Codex writes changed the digests: %+v", got)
	}

	// The user's own MCP servers never run, so they are not configuration.
	write(filepath.Join(shared, "config.toml"), "model = \"m\"\n[mcp_servers.other]\ncommand = \"y\"\n")
	if got := project(); got.ConfigDigest != base.ConfigDigest {
		t.Fatal("an MCP server edit changed the configuration digest")
	}

	write(filepath.Join(user, ".agents", "skills", "mine", "SKILL.md"), skill("mine", "Second"))
	edited := project()
	if edited.SkillDigest == base.SkillDigest || edited.ConfigDigest != base.ConfigDigest {
		t.Fatalf("a Skill edit = %+v", edited)
	}
	write(filepath.Join(user, ".agents", "skills", "added", "SKILL.md"), skill("added", "New"))
	added := project()
	if added.SkillDigest == edited.SkillDigest {
		t.Fatal("an added Skill kept the digest")
	}
	write(filepath.Join(shared, "config.toml"), "model = \"m\"\n[[skills.config]]\nname = \"added\"\nenabled = false\n")
	if disabled := project(); disabled.SkillDigest == added.SkillDigest {
		t.Fatal("disabling a Skill kept the digest")
	}
	write(filepath.Join(shared, "AGENTS.md"), "Be brief.")
	if got := project(); got.ConfigDigest == base.ConfigDigest {
		t.Fatal("an AGENTS.md edit kept the configuration digest")
	}
}
