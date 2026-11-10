//go:build !windows

package control

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// processRecord is one process generation: its start time tells a reused PID
// from the original.
type processRecord struct {
	PID, ParentPID, ProcessGroupID int
	State, StartTime               string
}

func (r processRecord) same(other processRecord) bool {
	return r.PID == other.PID && r.ProcessGroupID == other.ProcessGroupID && r.StartTime == other.StartTime
}

func (r processRecord) terminal() bool {
	return strings.HasPrefix(r.State, "Z") || r.State == "X" || r.State == "x"
}

// readProcessTable reads every process with the start time format the Daemon
// records for itself.
func readProcessTable(ctx context.Context) ([]processRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if runtime.GOOS == "linux" {
		return readLinuxProcessTable(ctx)
	}
	command := exec.CommandContext(ctx, "/bin/ps", "-axo", "pid=,ppid=,pgid=,state=,lstart=")
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "LC_ALL=C"}
	output, err := command.Output()
	if err != nil {
		return nil, errors.New("unable to inspect Computer processes")
	}
	var records []processRecord
	for _, line := range strings.Split(string(output), "\n") {
		match := psLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		pid, _ := strconv.Atoi(match[1])
		parent, _ := strconv.Atoi(match[2])
		group, _ := strconv.Atoi(match[3])
		if pid > 0 && group > 0 {
			records = append(records, processRecord{PID: pid, ParentPID: parent, ProcessGroupID: group, State: match[4], StartTime: match[5]})
		}
	}
	return records, nil
}

var psLine = regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$`)

func readLinuxProcessTable(ctx context.Context) ([]processRecord, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, errors.New("unable to inspect Computer processes")
	}
	records := make([]processRecord, 0, len(entries))
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid < 1 {
			continue
		}
		if ctx.Err() != nil {
			return nil, errors.New("Computer process inspection timed out")
		}
		record, ok, err := readLinuxProcess(pid)
		if err != nil {
			return nil, err
		}
		if ok {
			records = append(records, record)
		}
	}
	return records, nil
}

func readLinuxProcess(pid int) (processRecord, bool, error) {
	encoded, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if errors.Is(err, os.ErrNotExist) {
		return processRecord{}, false, nil
	}
	if err != nil {
		return processRecord{}, false, errors.New("unable to inspect Computer processes")
	}
	stat := string(encoded)
	closeParenthesis := strings.LastIndexByte(stat, ')')
	if closeParenthesis < 0 {
		// A process that exits mid-read can leave a truncated record.
		return processRecord{}, false, nil
	}
	fields := strings.Fields(stat[closeParenthesis+1:])
	if len(fields) < 20 {
		return processRecord{}, false, nil
	}
	parent, parentErr := strconv.Atoi(fields[1])
	group, groupErr := strconv.Atoi(fields[2])
	if parentErr != nil || groupErr != nil || len(fields[0]) != 1 || fields[19] == "" {
		return processRecord{}, false, errors.New("malformed Computer process record")
	}
	// Kernel threads have no user process group.
	if group == 0 {
		return processRecord{}, false, nil
	}
	return processRecord{PID: pid, ParentPID: parent, ProcessGroupID: group, State: fields[0], StartTime: fields[19]}, true, nil
}
