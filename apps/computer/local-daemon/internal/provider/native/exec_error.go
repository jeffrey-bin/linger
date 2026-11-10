package native

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
)

// execFormatError explains an executable built for another platform.
type execFormatError struct{ cause error }

func (e *execFormatError) Error() string {
	return fmt.Sprintf("Runtime executable cannot run on %s/%s; reinstall the CLI for this platform: %v", runtime.GOOS, runtime.GOARCH, e.cause)
}

func (e *execFormatError) Unwrap() error { return e.cause }

// ExplainExecError explains an executable-format failure and returns every
// other error, including one it already explained, as the identical value.
func ExplainExecError(err error) error {
	if err == nil {
		return nil
	}
	var explained *execFormatError
	if errors.As(err, &explained) {
		return err
	}
	if errors.Is(err, syscall.ENOEXEC) || badExeFormat(err) {
		return &execFormatError{cause: err}
	}
	return err
}
