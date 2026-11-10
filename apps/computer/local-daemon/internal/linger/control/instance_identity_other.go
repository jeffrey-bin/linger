//go:build !linux && !darwin && !windows

package control

import (
	"context"
	"errors"
)

func currentProcessIdentity(context.Context) (processIdentity, error) {
	return processIdentity{}, errors.New("Daemon process identity is unsupported on this platform")
}
