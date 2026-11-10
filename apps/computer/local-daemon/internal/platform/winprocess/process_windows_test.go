//go:build windows

package winprocess

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"golang.org/x/sys/windows"
)

func TestProcessFixture(t *testing.T) {
	if os.Getenv("LINGER_WINPROCESS_FIXTURE") != "1" {
		return
	}
	for {
		time.Sleep(time.Second)
	}
}

func TestInspectDoesNotAdoptSystemProcess(t *testing.T) {
	identity, err := Inspect(4)
	if err != nil || identity != nil {
		t.Fatalf("system process must not block stale-owner recovery: %+v %v", identity, err)
	}
}

func TestOpenMatchingChecksGenerationBeforeTerminationPermission(t *testing.T) {
	child := exec.Command(os.Args[0], "-test.run=^TestProcessFixture$")
	child.Env = append(os.Environ(), "LINGER_WINPROCESS_FIXTURE=1")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
	identity, err := Inspect(child.Process.Pid)
	if err != nil || identity == nil {
		t.Fatalf("identity=%+v %v", identity, err)
	}
	control, err := windows.OpenProcess(windows.WRITE_DAC, false, uint32(child.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(control)
	sid, err := privatefs.CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;;0x00101000;;;" + sid.String() + ")")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetSecurityInfo(control, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	stale := *identity
	stale.StartTime = "windows:1"
	handle, current, err := OpenMatching(stale, windows.PROCESS_TERMINATE)
	if handle != 0 {
		windows.CloseHandle(handle)
	}
	if err != nil || current != nil || handle != 0 {
		t.Fatalf("stale generation required termination rights: handle=%v identity=%+v err=%v", handle, current, err)
	}
	if current, err := Inspect(child.Process.Pid); err != nil || current == nil || *current != *identity {
		t.Fatalf("unrelated generation changed: %+v %v", current, err)
	}
	if err := Terminate(context.Background(), *identity); err == nil {
		t.Fatal("matching live process silently ignored denied termination permission")
	}
}
func TestTerminationRejectsGenerationMismatchAndPreservesOtherProcess(t *testing.T) {
	child := exec.Command(os.Args[0], "-test.run=^TestProcessFixture$")
	child.Env = append(os.Environ(), "LINGER_WINPROCESS_FIXTURE=1")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
	identity, err := Inspect(child.Process.Pid)
	if err != nil || identity == nil {
		t.Fatalf("identity=%+v %v", identity, err)
	}
	forged := *identity
	forged.StartTime = "windows:1"
	if err := Terminate(context.Background(), forged); err != nil {
		t.Fatalf("stale generation must not block recovery: %v", err)
	}
	if got, err := Inspect(child.Process.Pid); err != nil || got == nil || *got != *identity {
		t.Fatalf("child changed: %+v %v", got, err)
	}
	self, err := Inspect(os.Getpid())
	if err != nil || self == nil {
		t.Fatal(err)
	}
	if err := Terminate(context.Background(), *identity); err != nil {
		t.Fatal(err)
	}
	if got, err := Inspect(os.Getpid()); err != nil || got == nil || *got != *self {
		t.Fatalf("unrelated process changed: %+v %v", got, err)
	}
}
