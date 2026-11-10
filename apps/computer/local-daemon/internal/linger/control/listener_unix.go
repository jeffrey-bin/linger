//go:build !windows

package control

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func SocketPath(stateDirectory string) (string, error) {
	absolute, err := filepath.Abs(stateDirectory)
	if err != nil {
		return "", err
	}
	colocated := filepath.Join(absolute, "control.sock")
	if len([]byte(colocated)) <= 100 {
		return colocated, nil
	}
	digest := sha256.Sum256([]byte(absolute))
	return filepath.Join("/tmp", "sx-c-"+strconv.Itoa(os.Getuid())+"-"+hex.EncodeToString(digest[:]), "control.sock"), nil
}

func (s *Server) Start() error {
	parent := filepath.Dir(s.socketPath)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(parent, 0o700); err != nil { //nolint:gosec // owner-only directory mode; gosec expects a file mode for Chmod
		return err
	}
	if info, err := os.Lstat(s.socketPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("control socket path is occupied by a non-socket")
		}
		connection, dialErr := net.DialTimeout("unix", s.socketPath, 100*time.Millisecond)
		if dialErr == nil {
			_ = connection.Close()
			return errors.New("Local Computer Daemon is already running")
		}
		if err := os.Remove(s.socketPath); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	listener, err := net.Listen("unix", s.socketPath)
	if err != nil {
		return err
	}
	if err := os.Chmod(s.socketPath, 0o600); err != nil {
		_ = listener.Close()
		return err
	}
	s.listener = listener
	s.server = &http.Server{Handler: http.HandlerFunc(s.handle), ReadHeaderTimeout: 2 * time.Second}
	go func() { _ = s.server.Serve(listener) }()
	return nil
}

func (s *Server) Close(ctx context.Context) error {
	if s.server != nil {
		_ = s.server.Shutdown(ctx)
	}
	if s.listener != nil {
		_ = s.listener.Close()
	}
	if err := os.Remove(s.socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent := filepath.Dir(s.socketPath)
	if strings.HasPrefix(parent, "/tmp/sx-c-") {
		_ = os.Remove(parent)
	}
	return nil
}
