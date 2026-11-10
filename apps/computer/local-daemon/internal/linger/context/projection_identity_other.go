//go:build !linux && !darwin && !windows

package lingercontext

import (
	"errors"
	"os"
)

func projectionIdentity(path string) (projectionFileIdentity, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return projectionFileIdentity{}, errors.New("projection file is unavailable")
	}
	return projectionFileIdentity{Size: info.Size()}, nil
}
