package workspace

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// ClaudeSkill is local discovery metadata. Path never crosses the wire.
type ClaudeSkill struct {
	Name, Description, Path, Source string
	Enabled                         bool
}

// DiscoverClaudeSkills reads the Computer user's own Claude Skill trees without
// importing their files. Two sources qualify, and only two:
//
//   - personal Skills the user wrote or installed under `<configHome>/skills`;
//   - Skills carried by a plugin the user actually installed, as recorded in
//     `plugins/installed_plugins.json`.
//
// `<configHome>/skills/synced` and `plugins/marketplaces` are deliberately not
// sources. The first holds claude.ai account-synced Skills, which the Runtime
// disables through syncClaudeAiSkills/syncClaudeAiPlugins; inheriting them by
// another route would quietly reverse that decision. The second is a
// marketplace checkout, so a Skill living there has been fetched, not
// installed.
func DiscoverClaudeSkills(configHome string) ([]ClaudeSkill, error) {
	if strings.TrimSpace(configHome) == "" {
		return nil, nil
	}
	var result []ClaudeSkill
	seen := map[string]bool{}
	scan := func(root, source string) error {
		entries, err := os.ReadDir(root)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if len(result) >= 256 {
				return errors.New("Claude Skill catalog exceeds 256 entries")
			}
			if strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			path := filepath.Join(root, entry.Name(), "SKILL.md")
			info, err := os.Stat(path)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() || info.Size() > 64*1024 {
				continue
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			meta, ok := parseSkillFrontmatter(raw)
			if !ok {
				continue
			}
			canonical, err := filepath.EvalSymlinks(path)
			if err != nil {
				return err
			}
			if seen[canonical] {
				continue
			}
			seen[canonical] = true
			result = append(result, ClaudeSkill{
				Name: meta.Name, Description: meta.Description,
				Path: canonical, Source: source, Enabled: true,
			})
		}
		return nil
	}
	if err := scan(filepath.Join(configHome, "skills"), "user"); err != nil {
		return nil, err
	}
	for _, plugin := range installedClaudePlugins(configHome) {
		if err := scan(filepath.Join(plugin.installPath, "skills"), plugin.name); err != nil {
			return nil, err
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

type installedClaudePlugin struct {
	name        string
	installPath string
}

// installedClaudePlugins reads the installed-plugin record. A missing,
// unreadable or malformed record means no plugin Skills are inherited; it never
// fails discovery, because personal Skills are still perfectly inheritable.
func installedClaudePlugins(configHome string) []installedClaudePlugin {
	raw, err := os.ReadFile(filepath.Join(configHome, "plugins", "installed_plugins.json"))
	if err != nil || len(raw) > 4*1024*1024 {
		return nil
	}
	var record struct {
		Plugins map[string][]struct {
			InstallPath string `json:"installPath"`
		} `json:"plugins"`
	}
	if json.Unmarshal(raw, &record) != nil {
		return nil
	}
	keys := make([]string, 0, len(record.Plugins))
	for key := range record.Plugins {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var plugins []installedClaudePlugin
	for _, key := range keys {
		name := key
		if at := strings.Index(key, "@"); at > 0 {
			name = key[:at]
		}
		if !safeSkillComponent(name) {
			continue
		}
		for _, installation := range record.Plugins[key] {
			if installation.InstallPath == "" || !filepath.IsAbs(installation.InstallPath) {
				continue
			}
			plugins = append(plugins, installedClaudePlugin{name: name, installPath: installation.InstallPath})
		}
	}
	return plugins
}

type skillFrontmatter struct {
	Name, Description string
}

func parseSkillFrontmatter(raw []byte) (skillFrontmatter, bool) {
	parts := strings.SplitN(strings.ReplaceAll(string(raw), "\r\n", "\n"), "---", 3)
	if len(parts) != 3 || strings.TrimSpace(parts[0]) != "" {
		return skillFrontmatter{}, false
	}
	var meta skillFrontmatter
	if yaml.Unmarshal([]byte(parts[1]), &meta) != nil {
		return skillFrontmatter{}, false
	}
	meta.Name = strings.TrimSpace(meta.Name)
	meta.Description = strings.TrimSpace(meta.Description)
	if meta.Name == "" || meta.Description == "" || len([]rune(meta.Name)) > 64 {
		return skillFrontmatter{}, false
	}
	if description := []rune(meta.Description); len(description) > 1024 {
		meta.Description = string(description[:1024])
	}
	return meta, true
}

// SyncClaudeSkills links inherited Skills into the isolated Claude
// configuration directory, which the Runtime loads as its `user` setting
// source. Claude Code identifies a Skill by its directory name, not by the
// `name` in its frontmatter, so the link name is the invocable name and must be
// the real one — the opaque `linger-local-<hash>` naming the Codex projection
// uses would make every inherited Skill uncallable.
//
// The Skill's own bytes stay on the Computer. Only a link is created, so a
// Skill that ships a large binary costs nothing per Operation.
//
// platformSkillRoot names the Context's authorized Skill Snapshot. Those
// Skills already reach the Runtime through the project setting source, and a
// host Skill that shares a name with one is skipped rather than renamed: two
// entries answering to one name would let the model reach the wrong one.
// Returned names are exactly the Skills that were linked.
func SyncClaudeSkills(configRoot, configHome, platformSkillRoot string) ([]string, error) {
	root := filepath.Join(configRoot, "skills")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	skills, err := DiscoverClaudeSkills(configHome)
	if err != nil {
		// Inheritance is additive. An unreadable host tree leaves the Context's
		// own authorized Skills intact rather than failing the Operation.
		skills = nil
	}
	platform := map[string]bool{}
	if entries, err := os.ReadDir(platformSkillRoot); err == nil {
		for _, entry := range entries {
			platform[entry.Name()] = true
		}
	}
	expected := map[string]string{}
	for _, skill := range skills {
		if !skill.Enabled || !safeSkillComponent(skill.Name) || platform[skill.Name] {
			continue
		}
		expected[skill.Name] = filepath.Dir(skill.Path)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		path := filepath.Join(root, entry.Name())
		linked, err := os.Readlink(path)
		if err != nil {
			// This directory is daemon-owned. Anything in it that is no longer a
			// link is stale state to replace, not an Operation failure.
			if err := os.RemoveAll(path); err != nil {
				return nil, err
			}
			continue
		}
		if expected[entry.Name()] != linked {
			if err := os.Remove(path); err != nil {
				return nil, err
			}
		}
	}
	names := make([]string, 0, len(expected))
	for name, source := range expected {
		if err := ensureSymlink(source, filepath.Join(root, name)); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}
