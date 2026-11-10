//go:build windows

package control

import (
	"context"
	"errors"
	"os"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winprocess"
)

func currentProcessIdentity(context.Context) (processIdentity, error) {
	identity, err := winprocess.Inspect(os.Getpid())
	if err != nil {
		return processIdentity{}, err
	}
	if identity == nil {
		return processIdentity{}, errors.New("current process identity is unavailable")
	}
	return processIdentity{PID: identity.PID, ProcessGroupID: identity.ProcessGroupID, StartTime: identity.StartTime}, nil
}
