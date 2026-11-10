//go:build unix

package artifact

import "golang.org/x/sys/unix"

func availableBytes(root string) (uint64, error) {
	var state unix.Statfs_t
	if err := unix.Statfs(root, &state); err != nil {
		return 0, err
	}
	return state.Bavail * uint64(state.Bsize), nil
}
