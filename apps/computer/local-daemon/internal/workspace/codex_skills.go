package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pelletier/go-toml/v2"
	"gopkg.in/yaml.v3"
)

// CodexSkill is local discovery metadata. Path never crosses the wire.
type CodexSkill struct {
	Name, Description, Path, Source string
	Enabled                         bool
	// contentSHA is the SKILL.md content the Skill was discovered with.
	contentSHA string
}

// DiscoverCodexSkills reads user-owned Skill trees, without importing their files
// or starting plugins/MCP servers. Context state is deliberately not a source.
func DiscoverCodexSkills(sharedHome, userHome string) ([]CodexSkill, error) {
	var config struct {
		Skills struct {
			Config []struct {
				Path, Name string
				Enabled    *bool
			}
		}
		Plugins map[string]struct{ Enabled bool }
	}
	raw, err := os.ReadFile(filepath.Join(sharedHome, "config.toml"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if len(raw) > 4*1024*1024 {
		return nil, errors.New("Codex config exceeds discovery limit")
	}
	if len(raw) > 0 {
		if err := toml.Unmarshal(raw, &config); err != nil {
			return nil, fmt.Errorf("read Codex Skill settings: %w", err)
		}
	}
	var result []CodexSkill
	seen := map[string]bool{}
	// Hidden directories are skipped, .system included: Codex unpacks its
	// bundled Skills there, and they describe Codex itself (image generation,
	// OpenAI docs, Skill authoring) rather than the Agent.
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
				return errors.New("Codex Skill catalog exceeds 256 entries")
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
			parts := strings.SplitN(strings.ReplaceAll(string(raw), "\r\n", "\n"), "---", 3)
			if len(parts) != 3 || strings.TrimSpace(parts[0]) != "" {
				continue
			}
			var meta struct{ Name, Description string }
			if yaml.Unmarshal([]byte(parts[1]), &meta) != nil || strings.TrimSpace(meta.Name) == "" || strings.TrimSpace(meta.Description) == "" {
				continue
			}
			if len([]rune(meta.Name)) > 64 {
				continue
			}
			if description := []rune(meta.Description); len(description) > 1024 {
				meta.Description = string(description[:1024])
			}
			canonical, err := filepath.EvalSymlinks(path)
			if err != nil {
				return err
			}
			if seen[canonical] {
				continue
			}
			seen[canonical] = true
			enabled := true
			for _, setting := range config.Skills.Config {
				configured := setting.Path
				if configured != "" && !filepath.IsAbs(configured) {
					configured = filepath.Join(sharedHome, configured)
				}
				if resolved, err := filepath.EvalSymlinks(configured); err == nil {
					configured = resolved
				}
				if setting.Enabled != nil && (configured == canonical || configured == filepath.Dir(canonical) || setting.Name == meta.Name || setting.Name == source+":"+meta.Name) {
					enabled = *setting.Enabled
				}
			}
			content := sha256.Sum256(raw)
			result = append(result, CodexSkill{Name: meta.Name, Description: meta.Description, Path: canonical, Source: source, Enabled: enabled,
				contentSHA: hex.EncodeToString(content[:])})
		}
		return nil
	}
	if userHome != "" {
		if err := scan(filepath.Join(userHome, ".agents", "skills"), "user"); err != nil {
			return nil, err
		}
	}
	if err := scan(filepath.Join(sharedHome, "skills"), "codex"); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(config.Plugins))
	for name, p := range config.Plugins {
		if p.Enabled {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		parts := strings.Split(name, "@")
		if len(parts) != 2 || !safeSkillComponent(parts[0]) || !safeSkillComponent(parts[1]) {
			continue
		}
		root := filepath.Join(sharedHome, "plugins", "cache", parts[1], parts[0])
		versions, err := os.ReadDir(root)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		// An installed cache normally contains one revision. If there are several,
		// use the newest installed revision rather than loading stale duplicates.
		sort.SliceStable(versions, func(i, j int) bool {
			a, ea := versions[i].Info()
			b, eb := versions[j].Info()
			if ea != nil || eb != nil {
				return versions[i].Name() < versions[j].Name()
			}
			return a.ModTime().After(b.ModTime())
		})
		for _, version := range versions {
			if !version.IsDir() {
				continue
			}
			if err := scan(filepath.Join(root, version.Name(), "skills"), parts[0]); err != nil {
				return nil, err
			}
			break
		}
	}
	return result, nil
}

func safeSkillComponent(value string) bool {
	return value != "" && value != "." && value != ".." && !strings.ContainsAny(value, "/\\")
}

// syncCodexSkills projects only Skill directories; sessions, plugin
// executors, hooks and credentials remain outside this projection. It returns
// the digest of what it projected: each link and its source, each linked
// Skill's content, and the disable rules. Entries outside the Daemon's
// linger-local-* namespace, such as Skills Codex installs itself, are not
// projected and do not count.
func syncCodexSkills(target, sharedHome, userHome string) (string, error) {
	skills, err := DiscoverCodexSkills(sharedHome, userHome)
	if err != nil {
		return "", err
	}
	root := filepath.Join(target, "skills")
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	expected := map[string]string{}
	for _, skill := range skills {
		if skill.Enabled {
			sum := sha256.Sum256([]byte(skill.Path))
			expected["linger-local-"+hex.EncodeToString(sum[:12])] = filepath.Dir(skill.Path)
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "linger-local-") {
			continue
		}
		path := filepath.Join(root, entry.Name())
		linked, err := os.Readlink(path)
		if err != nil {
			// The linger-local-* namespace is daemon-owned; anything that is no
			// longer a link there is stale state to replace, not a Run failure.
			if err := os.RemoveAll(path); err != nil {
				return "", fmt.Errorf("replace stale inherited Skill entry %s: %w", entry.Name(), err)
			}
			continue
		}
		if expected[entry.Name()] != linked {
			if err := os.Remove(path); err != nil {
				return "", err
			}
		}
	}
	for name, source := range expected {
		if err := ensureSymlink(source, filepath.Join(root, name)); err != nil {
			return "", err
		}
	}
	// Preserve disable rules for native discovery through the real HOME too.
	var disabled strings.Builder
	for _, skill := range skills {
		if !skill.Enabled {
			fmt.Fprintf(&disabled, "\n[[skills.config]]\npath = %q\nenabled = false\n", skill.Path)
		}
	}
	if disabled.Len() > 0 {
		f, err := os.OpenFile(filepath.Join(target, "config.toml"), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0600)
		if err != nil {
			return "", err
		}
		_, err = f.WriteString(disabled.String())
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return "", err
		}
	}
	return codexSkillDigest(skills, expected, disabled.String()), nil
}

// codexSkillDigest identifies a Skill projection in a stable order.
func codexSkillDigest(skills []CodexSkill, links map[string]string, disabled string) string {
	var records []string
	for name, source := range links {
		records = append(records, "link\x00"+name+"\x00"+source)
	}
	for _, skill := range skills {
		if skill.Enabled {
			records = append(records, "skill\x00"+skill.Path+"\x00"+skill.contentSHA)
		}
	}
	sort.Strings(records)
	sum := sha256.New()
	for _, record := range records {
		_, _ = fmt.Fprintf(sum, "%d:%s\n", len(record), record)
	}
	_, _ = fmt.Fprintf(sum, "disabled %d:%s\n", len(disabled), disabled)
	return hex.EncodeToString(sum.Sum(nil))
}
