//go:build darwin

package control

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

func currentProcessIdentity(ctx context.Context) (processIdentity, error) {
	pid := os.Getpid()
	command := exec.CommandContext(ctx, "/bin/ps", "-p", strconv.Itoa(pid), "-o", "pgid=,lstart=")
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "LC_ALL=C"}
	output, err := command.Output()
	if err != nil {
		return processIdentity{}, err
	}
	trimmed := strings.TrimSpace(string(output))
	fields := strings.Fields(trimmed)
	if len(fields) < 6 {
		return processIdentity{}, errors.New("invalid ps process identity")
	}
	processGroupID, err := strconv.Atoi(fields[0])
	if err != nil || processGroupID < 1 {
		return processIdentity{}, errors.New("invalid process group identity")
	}
	start := strings.TrimSpace(strings.TrimPrefix(trimmed, fields[0]))
	if start == "" {
		return processIdentity{}, errors.New("missing process start time")
	}
	return processIdentity{PID: pid, ProcessGroupID: processGroupID, StartTime: start}, nil
}
