//go:build linux

package control

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
)

func currentProcessIdentity(context.Context) (processIdentity, error) {
	pid := os.Getpid()
	encoded, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		return processIdentity{}, err
	}
	closeParenthesis := strings.LastIndexByte(string(encoded), ')')
	if closeParenthesis < 0 {
		return processIdentity{}, errors.New("invalid /proc/self/stat")
	}
	fields := strings.Fields(string(encoded[closeParenthesis+1:]))
	if len(fields) < 20 {
		return processIdentity{}, errors.New("incomplete /proc/self/stat")
	}
	processGroupID, err := strconv.Atoi(fields[2])
	if err != nil || processGroupID < 1 || fields[19] == "" {
		return processIdentity{}, errors.New("invalid process identity")
	}
	return processIdentity{PID: pid, ProcessGroupID: processGroupID, StartTime: fields[19]}, nil
}
