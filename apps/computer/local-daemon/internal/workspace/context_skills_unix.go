//go:build !windows

package workspace

import (
	"errors"
	"os"
)

func ensureClaudeProjectSkills(root *os.Root) error {
	const target = "../.agents/skills"
	if info, err := root.Lstat(".claude/skills"); err == nil {
		if info.Mode()&os.ModeSymlink == 0 {
			return errors.New("Claude Skill projection conflicts with local files")
		}
		value, err := root.Readlink(".claude/skills")
		if err != nil || value != target {
			return errors.New("Claude Skill projection is unsafe")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return root.Symlink(target, ".claude/skills")
}
