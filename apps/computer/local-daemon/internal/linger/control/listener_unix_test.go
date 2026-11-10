//go:build !windows

package control

import (
	"context"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

func TestSocketPathUsesCompatibleLongPathFallback(t *testing.T) {
	path, err := SocketPath(filepath.Join(t.TempDir(), strings.Repeat("long", 40)))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(path, "/tmp/sx-c-") || len([]byte(path)) > 100 {
		t.Fatalf("fallback path=%q", path)
	}
}

func localHTTPClient(socketPath string) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	}}}
}
