package privatefs

import "golang.org/x/sys/unix"

func publishExclusive(source, destination string) error {
	return publishWithFallback(source, destination,
		unix.Renameat2(unix.AT_FDCWD, source, unix.AT_FDCWD, destination, unix.RENAME_NOREPLACE))
}
