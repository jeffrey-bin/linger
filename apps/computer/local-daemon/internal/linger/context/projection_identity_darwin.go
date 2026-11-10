//go:build darwin

package lingercontext

import (
	"errors"
	"os"
	"syscall"
)

func projectionIdentity(path string) (projectionFileIdentity, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return projectionFileIdentity{}, errors.New("projection file is unavailable")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return projectionFileIdentity{}, errors.New("projection file identity is unavailable")
	}
	return projectionFileIdentity{
		Device: uint64(stat.Dev), Inode: stat.Ino, Size: info.Size(), Mode: uint32(info.Mode()),
		ModifiedNsec: info.ModTime().UnixNano(), ChangedNsec: stat.Ctimespec.Sec*1_000_000_000 + stat.Ctimespec.Nsec, Cacheable: true,
	}, nil
}
