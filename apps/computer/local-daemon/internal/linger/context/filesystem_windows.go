//go:build windows

package lingercontext

import (
	"errors"
	"os"
	"path"
	"strings"
	"unicode"
)

const contextFileOpenFlags = os.O_RDONLY

func validatePlatformRelativePath(relative string) error {
	for _, segment := range strings.Split(relative, "/") {
		if segment == "" || segment == "." || segment == ".." || strings.TrimRight(segment, ". ") != segment || strings.ContainsAny(segment, `<>:"\|?*`) || strings.IndexFunc(segment, func(r rune) bool { return unicode.IsControl(r) }) >= 0 {
			return errors.New("Context path is not representable on Windows")
		}
		stem := strings.ToUpper(strings.SplitN(segment, ".", 2)[0])
		if stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" || stem == "CONIN$" || stem == "CONOUT$" || ((strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) && strings.Contains("123456789¹²³", strings.TrimPrefix(strings.TrimPrefix(stem, "COM"), "LPT")) && len([]rune(stem)) == 4) {
			return errors.New("Context path uses a reserved Windows name")
		}
	}
	return nil
}
func validatePlatformMappings(mappings []Mapping) error {
	spellings := map[string]string{}
	register := func(relative string) error {
		if err := validatePlatformRelativePath(relative); err != nil {
			return err
		}
		prefix := ""
		for _, part := range strings.Split(relative, "/") {
			prefix = path.Join(prefix, part)
			key := strings.ToUpper(prefix)
			if previous, ok := spellings[key]; ok && previous != prefix {
				return errors.New("Context paths collide on Windows")
			}
			spellings[key] = prefix
		}
		return nil
	}
	for _, mapping := range mappings {
		if err := register(mapping.TargetPath); err != nil {
			return err
		}
		for _, file := range mapping.Files {
			if err := validatePlatformRelativePath(file.RelativePath); err != nil {
				return err
			}
			if err := register(path.Join(mapping.TargetPath, file.RelativePath)); err != nil {
				return err
			}
		}
	}
	return nil
}
func replaceProjectionFile(root *os.Root, source, target string) error {
	previous, err := root.Stat(target)
	if errors.Is(err, os.ErrNotExist) {
		return root.Rename(source, target)
	}
	if err != nil {
		return err
	}
	if err := chmodOpened(root, target, 0o600); err != nil {
		return err
	}
	if err := root.Rename(source, target); err != nil {
		_ = chmodOpened(root, target, previous.Mode())
		return err
	}
	return nil
}

// Windows has no directory fsync primitive available to an ordinary user.
// Contents are flushed before publication; the SQLite projection journal
// replays interrupted replacements on the next activation.
func syncDirectory(_ *os.Root, _ string) error { return nil }
