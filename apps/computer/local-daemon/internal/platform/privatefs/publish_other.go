//go:build !darwin && !linux && !windows

package privatefs

import "errors"

func publishExclusive(source, destination string) error {
	return errors.ErrUnsupported
}
