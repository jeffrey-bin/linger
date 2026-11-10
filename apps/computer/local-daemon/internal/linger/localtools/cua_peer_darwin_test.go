package localtools

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestCuaServicePIDNamesTheListeningProcess(t *testing.T) {
	// The test temp directory is longer than a macOS socket path allows.
	directory, err := os.MkdirTemp("/tmp", "cua-pid-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	socket := filepath.Join(directory, "driver.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		if connection, err := listener.Accept(); err == nil {
			_ = connection.Close()
		}
	}()
	if got := cuaServicePID(socket); got != os.Getpid() {
		t.Fatalf("pid = %d, want %d", got, os.Getpid())
	}
	if got := cuaServicePID(filepath.Join(t.TempDir(), "missing.sock")); got != 0 {
		t.Fatalf("missing socket pid = %d", got)
	}
}
