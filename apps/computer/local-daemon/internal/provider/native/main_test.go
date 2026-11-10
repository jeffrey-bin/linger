package native

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The test binary doubles as a fake CLI: a child started with
// fixtureEnvKey runs the named fixture instead of the tests.
const fixtureEnvKey = "NATIVE_TEST_FIXTURE"

func TestMain(m *testing.M) {
	if name := os.Getenv(fixtureEnvKey); name != "" {
		os.Exit(runFixture(name, os.Args[1:]))
	}
	os.Exit(m.Run())
}

// fixtureInvocation runs this test binary as fixture name with exactly env.
func fixtureInvocation(t *testing.T, name string, env map[string]string) Invocation {
	t.Helper()
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	full := map[string]string{fixtureEnvKey: name}
	for key, value := range env {
		full[key] = value
	}
	return NewInvocation(program, nil).WithEnvironment(full)
}

func runFixture(name string, args []string) int {
	switch name {
	case "print":
		fmt.Print(os.Getenv("FIXTURE_STDOUT"))
		code, _ := strconv.Atoi(os.Getenv("FIXTURE_EXIT"))
		return code
	case "block":
		time.Sleep(time.Minute)
		return 0
	case "claude-catalog":
		return claudeCatalogFixture(args)
	}
	fmt.Fprintf(os.Stderr, "unknown fixture %q\n", name)
	return 2
}

func claudeCatalogFixture(args []string) int {
	if strings.Join(args, "\x00") != strings.Join(claudeCatalogArgs, "\x00") {
		fmt.Fprintln(os.Stderr, "unexpected argv")
		return 3
	}
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil {
		return 4
	}
	var request struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
		Request   struct {
			Subtype string `json:"subtype"`
		} `json:"request"`
	}
	if json.Unmarshal([]byte(line), &request) != nil || request.Type != "control_request" || request.Request.Subtype != "initialize" {
		return 5
	}
	fmt.Println(`{"type":"system","subtype":"noise"}`)
	fmt.Println("not json")
	fmt.Println(`{"type":"control_response","response":{"request_id":"other","subtype":"error"}}`)
	if os.Getenv("FIXTURE_MODE") == "reject" {
		fmt.Printf(`{"type":"control_response","response":{"request_id":%q,"subtype":"error","error":"no"}}`+"\n", request.RequestID)
	} else {
		if models := os.Getenv("FIXTURE_MODELS"); models != "" {
			var entries []json.RawMessage
			if json.Unmarshal([]byte(models), &entries) != nil {
				return 4
			}
			compact, _ := json.Marshal(entries)
			fmt.Printf(`{"type":"control_response","response":{"request_id":%q,"subtype":"success","response":{"models":%s}}}`+"\n", request.RequestID, compact)
		} else {
			fmt.Printf(`{"type":"control_response","response":{"request_id":%q,"subtype":"success","response":{"models":[`+
				`{"value":"organization-alias","resolvedModel":"organization-model","displayName":"Organization","supportedEffortLevels":["high","ultra","high"],"supportsEffort":true},`+
				`{"value":"quick-model","displayName":"","supportedEffortLevels":["high"],"supportsEffort":false},`+
				`{"value":"organization-model","displayName":"Again"}]}}}`+"\n", request.RequestID)
		}
	}
	// Wait for stdin to close, as the real CLI does.
	_, _ = reader.ReadString(0)
	return 0
}

// errSymlinkPrivilege is Windows ERROR_PRIVILEGE_NOT_HELD: a normal user
// without Developer Mode cannot create symlinks.
const errSymlinkPrivilege = syscall.Errno(1314)

// symlinkOrSkip creates link pointing at target. Only on Windows without the
// symlink privilege does it log and return false, so the caller skips just the
// symlink case; every other failure fails the test.
func symlinkOrSkip(t *testing.T, target, link string) bool {
	t.Helper()
	err := os.Symlink(target, link)
	if err == nil {
		return true
	}
	if runtime.GOOS == "windows" && errors.Is(err, errSymlinkPrivilege) {
		t.Logf("symlink case skipped: %v", err)
		return false
	}
	t.Fatal(err)
	return false
}
