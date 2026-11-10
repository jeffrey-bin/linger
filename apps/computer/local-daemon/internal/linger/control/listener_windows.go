//go:build windows

package control

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func SocketPath(stateDirectory string) (string, error) {
	owner, err := readControlOwner(stateDirectory)
	if err != nil {
		return "", err
	}
	return pipePath(stateDirectory, owner.Nonce)
}

func pipePath(stateDirectory, nonce string) (string, error) {
	absolute, err := filepath.Abs(stateDirectory)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(strings.ToLower(filepath.ToSlash(absolute)) + "\x00" + nonce))
	return `\\.\pipe\linger-computer-` + hex.EncodeToString(digest[:]), nil
}
func (s *Server) Start() error {
	descriptor, err := privatefs.PipeSecurityDescriptor()
	if err != nil {
		return err
	}
	listener, err := winio.ListenPipe(s.socketPath, &winio.PipeConfig{SecurityDescriptor: descriptor, InputBufferSize: 65536, OutputBufferSize: 65536})
	if err != nil {
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
		return s.listener.Close()
	}
	return nil
}
