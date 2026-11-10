//go:build !windows

package localskills

import (
	"io/fs"
	"os"
	"syscall"
)

func fileOwnerUID(info fs.FileInfo) (int, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int(stat.Uid), true
}

func assertSafePath(_ string, info fs.FileInfo, currentUID int) error {
	return assertSafeStat(info, currentUID)
}

func openSkillFile(path string) (*os.File, error) { return os.Open(path) }
func skillFileExecutable(_ string, info fs.FileInfo, _ []byte) bool {
	return info.Mode().Perm()&0o111 != 0
}
