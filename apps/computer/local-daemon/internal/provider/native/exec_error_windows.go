//go:build windows

package native

import (
	"errors"

	"golang.org/x/sys/windows"
)

func badExeFormat(err error) bool { return errors.Is(err, windows.ERROR_BAD_EXE_FORMAT) }
