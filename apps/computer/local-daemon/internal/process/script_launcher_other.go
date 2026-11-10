//go:build !windows

package process

import "os/exec"

func prepareScriptLauncher(*exec.Cmd) {}
