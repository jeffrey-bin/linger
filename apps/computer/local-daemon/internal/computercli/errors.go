package computercli

import (
	"errors"
	"io/fs"
	"syscall"
)

// Failure categories name the exit code of a failed command; doctor reports
// them as each check's category.
const (
	categoryInternal           = "internal"
	categoryUsage              = "usage"
	categoryConfiguration      = "configuration"
	categoryCredential         = "credential"
	categoryNetwork            = "network"
	categoryRuntimeUnavailable = "runtimeUnavailable"
	categoryCapabilityProbe    = "capabilityProbe"
	categoryDaemonLifecycle    = "daemonLifecycle"
	categoryRunnerLifecycle    = "runnerLifecycle"
)

var exitCodes = map[string]int{
	categoryInternal:           1,
	categoryUsage:              2,
	categoryConfiguration:      10,
	categoryCredential:         11,
	categoryNetwork:            12,
	categoryRuntimeUnavailable: 13,
	categoryCapabilityProbe:    14,
	categoryDaemonLifecycle:    15,
	categoryRunnerLifecycle:    16,
}

// cliError is a failure with the category that selects the exit code.
type cliError struct {
	category string
	message  string
	cause    error
}

func (e *cliError) Error() string { return e.message }
func (e *cliError) Unwrap() error { return e.cause }
func (e *cliError) exitCode() int { return exitCodes[e.category] }
func newError(category, message string) *cliError {
	return &cliError{category: category, message: message}
}

func wrapError(category, message string, cause error) *cliError {
	return &cliError{category: category, message: message, cause: cause}
}

// configError marks a Computer config that cannot be used.
type configError struct{ message string }

func (e *configError) Error() string { return e.message }

func asCLIError(err error) *cliError {
	var failure *cliError
	if errors.As(err, &failure) {
		return failure
	}
	var required *replacementRequiredError
	var expired *credentialExpiredError
	if errors.As(err, &required) || errors.As(err, &expired) {
		return wrapError(categoryCredential, err.Error(), err)
	}
	var config *configError
	if errors.As(err, &config) || errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) || errors.Is(err, fs.ErrPermission) {
		return wrapError(categoryConfiguration, err.Error(), err)
	}
	for _, code := range []syscall.Errno{syscall.ECONNREFUSED, syscall.ECONNRESET, syscall.ENETUNREACH, syscall.EHOSTUNREACH, syscall.ETIMEDOUT} {
		if errors.Is(err, code) {
			return wrapError(categoryNetwork, err.Error(), err)
		}
	}
	return wrapError(categoryInternal, err.Error(), err)
}

// unavailable reports that no Daemon answers for a state directory.
func unavailable(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.ECONNREFUSED)
}
