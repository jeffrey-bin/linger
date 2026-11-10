//go:build !unix

package selfupdate

import "errors"

func execProcess(string, []string, []string) error {
	return errors.New("Local Computer self-update handoff is not supported on this platform")
}
