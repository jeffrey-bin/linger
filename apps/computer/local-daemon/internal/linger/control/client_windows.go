//go:build windows

package control

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"regexp"
	"sync"

	"github.com/Microsoft/go-winio"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winprocess"
	"golang.org/x/sys/windows"
)

type controlOwner struct {
	winprocess.Identity
	Nonce string `json:"nonce"`
}

var instanceNoncePattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func readControlOwner(stateDirectory string) (controlOwner, error) {
	if !filepath.IsAbs(stateDirectory) {
		return controlOwner{}, errors.New("control state directory must be absolute")
	}
	data, err := privatefs.ReadFile(filepath.Join(stateDirectory, "daemon.lock", "owner.json"), 1024*1024)
	if err != nil {
		return controlOwner{}, err
	}
	var owner controlOwner
	if json.Unmarshal(data, &owner) != nil || !winprocess.Valid(owner.Identity) || !instanceNoncePattern.MatchString(owner.Nonce) {
		return controlOwner{}, errors.New("invalid control process identity")
	}
	return owner, nil
}

// controlDialer authenticates the server on the same connection used for HTTP.
// The nonce rotates with every private Daemon lease; peer validation also
// prevents a previously observed pipe name from becoming an impersonation path.
func controlDialer(stateDirectory string) (func(context.Context) (net.Conn, error), error) {
	owner, err := readControlOwner(stateDirectory)
	if err != nil {
		return nil, err
	}
	pipe, err := pipePath(stateDirectory, owner.Nonce)
	if err != nil {
		return nil, err
	}
	return func(ctx context.Context) (net.Conn, error) {
		connection, err := winio.DialPipeContext(ctx, pipe)
		if err != nil {
			return nil, err
		}
		fail := func(err error) (net.Conn, error) { _ = connection.Close(); return nil, err }
		file, ok := connection.(interface{ Fd() uintptr })
		if !ok {
			return fail(errors.New("control pipe handle is unavailable"))
		}
		var pid uint32
		if err := windows.GetNamedPipeServerProcessId(windows.Handle(file.Fd()), &pid); err != nil {
			return fail(err)
		}
		if int(pid) != owner.PID {
			return fail(errors.New("control pipe belongs to a different process"))
		}
		process, identity, err := winprocess.OpenMatching(owner.Identity, 0)
		if err != nil {
			return fail(err)
		}
		if identity == nil {
			return fail(errors.New("control process identity changed"))
		}
		return &authenticatedPipe{Conn: connection, process: process}, nil
	}, nil
}

type authenticatedPipe struct {
	net.Conn
	process   windows.Handle
	closeOnce sync.Once
	closeErr  error
}

func (p *authenticatedPipe) Close() error {
	p.closeOnce.Do(func() { p.closeErr = errors.Join(p.Conn.Close(), windows.CloseHandle(p.process)) })
	return p.closeErr
}
