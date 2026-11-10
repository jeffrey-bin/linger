//go:build !windows

package control

import (
	"context"
	"net"
)

func controlDialer(stateDirectory string) (func(context.Context) (net.Conn, error), error) {
	socketPath, err := SocketPath(stateDirectory)
	if err != nil {
		return nil, err
	}
	return func(ctx context.Context) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, "unix", socketPath)
	}, nil
}
