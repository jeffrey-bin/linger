package privatefs

import "golang.org/x/sys/unix"

func publishExclusive(source, destination string) error {
	return publishWithFallback(source, destination, unix.RenamexNp(source, destination, unix.RENAME_EXCL))
}
