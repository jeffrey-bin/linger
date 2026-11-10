//go:build unix

package selfupdate

import "syscall"

func execProcess(path string, args, environment []string) error {
	return syscall.Exec(path, args, environment)
}
