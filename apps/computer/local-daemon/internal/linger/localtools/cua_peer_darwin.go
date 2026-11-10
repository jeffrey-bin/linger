package localtools

import (
	"net"
	"time"

	"golang.org/x/sys/unix"
)

// cuaServicePID asks the kernel which process listens on the service socket,
// or returns 0. A file beside the socket would vanish when macOS cleans /tmp.
func cuaServicePID(socket string) int {
	connection, err := net.DialTimeout("unix", socket, 200*time.Millisecond)
	if err != nil {
		return 0
	}
	defer connection.Close()
	raw, err := connection.(*net.UnixConn).SyscallConn()
	if err != nil {
		return 0
	}
	pid := 0
	_ = raw.Control(func(fd uintptr) {
		pid, _ = unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
	})
	return pid
}
