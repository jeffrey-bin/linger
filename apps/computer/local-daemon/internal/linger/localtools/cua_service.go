package localtools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// Cua's ordinary `mcp` auto-launch prompts for OS permissions. Launch the
// signed application explicitly without that gate; the driver still enforces
// OS permissions and its normal action policy. Never grant permissions here.
// The service is shared by this Computer's Operations. Killing the stdio proxy
// does not terminate a service action, so cleanup always uses its owner session.
func (m *Manager) ensureCuaService(ctx context.Context) (string, error) {
	if runtime.GOOS != "darwin" {
		return "", errors.New("managed Cua requires macOS")
	}
	m.cuaLaunch.Lock()
	defer m.cuaLaunch.Unlock()
	directory := m.cuaServiceDirectory()
	if err := privatefs.EnsureDir(directory); err != nil {
		return "", err
	}
	socket := filepath.Join(directory, "driver.sock")
	listening := func() bool {
		connection, err := net.DialTimeout("unix", socket, 200*time.Millisecond)
		if err != nil {
			return false
		}
		_ = connection.Close()
		return true
	}
	if m.options.CuaEmbedded {
		if listening() {
			return socket, nil
		}
		return "", errors.New("trusted embedding host must start its owned Cua service before binding tools")
	}
	// The stamp records the settings the running service started with. A
	// service an earlier Computer started with other settings is replaced.
	stamp, settings := filepath.Join(directory, "environment"), strings.Join(cuaServiceEnvironment, "\n")
	if listening() {
		if current, _ := os.ReadFile(stamp); string(current) == settings {
			return socket, nil
		}
		if process, err := os.FindProcess(cuaServicePID(socket)); err == nil && process.Pid > 0 {
			_ = process.Signal(syscall.SIGTERM)
		}
		for stop := time.Now().Add(5 * time.Second); listening(); time.Sleep(100 * time.Millisecond) {
			if time.Now().After(stop) {
				return "", errors.New("the earlier Cua service did not stop; quit CuaDriver and try again")
			}
		}
	}
	launchCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	app := filepath.Join(filepath.Dir(m.options.CuaPath), "CuaDriver.app")
	arguments := []string{"-n", "-g"}
	for _, variable := range cuaServiceEnvironment {
		arguments = append(arguments, "--env", variable)
	}
	arguments = append(arguments, "-a", app, "--args", "serve", "--no-permissions-gate", "--socket", socket)
	command := exec.CommandContext(launchCtx, "/usr/bin/open", arguments...)
	command.Env = m.env
	if err := command.Run(); err != nil {
		return "", errors.New("Cua application could not start without prompting; repair the Computer installation")
	}
	// The pid identifies this service when a call later finds it stopped.
	for !listening() || cuaServicePID(socket) == 0 {
		select {
		case <-launchCtx.Done():
			return "", errors.New("Cua application did not become ready; no OS permissions were requested")
		case <-time.After(100 * time.Millisecond):
		}
	}
	if err := privatefs.WriteFile(stamp, []byte(settings), false); err != nil {
		return "", err
	}
	return socket, nil
}

// cuaServiceDirectory holds the service socket and its settings stamp. macOS
// Unix sockets have a short path limit, so it is a private, stable local
// directory keyed to this installation; it contains no user documents.
func (m *Manager) cuaServiceDirectory() string {
	sum := sha256.Sum256([]byte(m.options.StateDirectory + "\x00" + m.options.CuaPath))
	return filepath.Join("/tmp", fmt.Sprintf("linger-cua-%d-%s", os.Getuid(), hex.EncodeToString(sum[:8])))
}

// stopCuaService ends the service this installation launched so it does not
// outlive the Daemon, then removes its socket and settings stamp. The pid
// comes from the socket peer, the same trust the replacement path uses.
func (m *Manager) stopCuaService() error {
	if runtime.GOOS != "darwin" || m.options.CuaPath == "" {
		return nil
	}
	m.cuaLaunch.Lock()
	defer m.cuaLaunch.Unlock()
	directory := m.cuaServiceDirectory()
	socket := filepath.Join(directory, "driver.sock")
	if pid := cuaServicePID(socket); pid > 0 {
		if process, err := os.FindProcess(pid); err == nil {
			_ = process.Signal(syscall.SIGTERM)
		}
		for stop := time.Now().Add(5 * time.Second); cuaServicePID(socket) != 0; time.Sleep(100 * time.Millisecond) {
			if time.Now().After(stop) {
				return errors.New("the Cua service did not stop")
			}
		}
	}
	return os.RemoveAll(directory)
}

// errDriverGone reports a session whose service exited before this call.
var errDriverGone = fmt.Errorf("COMPUTER_DRIVER_RESTARTED: the desktop driver stopped before this call. The next computer call starts a new driver: read the window again first, because earlier element tokens no longer work: %w", errNotSent)

// errDriverStopped reports a Cua service that exited during a call. macOS
// stops the background driver application under memory pressure.
var errDriverStopped = errors.New("COMPUTER_DRIVER_RESTARTED: macOS stopped the desktop driver during this call, usually for low memory, so the call may or may not have taken effect. The next computer call starts a new driver: read the window again first, because earlier element tokens no longer work")

// driverStopped reports whether this session's transport closed because its
// service process exited. Then no action can still run, so the session
// settles its unknown action and retires; the Operation opens a new one.
func (c *cuaSession) driverStopped() bool {
	if c.servicePID == 0 || !c.client.closed() {
		return false
	}
	process, err := os.FindProcess(c.servicePID)
	if err != nil {
		return false
	}
	// The proxy can notice the closed socket before the service is reaped.
	for deadline := time.Now().Add(time.Second); ; {
		if errors.Is(process.Signal(syscall.Signal(0)), os.ErrProcessDone) {
			break
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.lost {
		c.lost, c.ended, c.started, c.desktop = true, true, false, false
		if c.unknown.finish(true) == nil {
			c.unknown = nil
		}
		_ = c.client.close()
	}
	return true
}

func (c *cuaSession) retired() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lost
}

// CuaPermissions reads CuaDriver's own Accessibility and Screen Recording
// grants through its check_permissions tool, without prompting.
func (m *Manager) CuaPermissions(ctx context.Context) (CuaPermissionReading, error) {
	if runtime.GOOS != "darwin" || !filepath.IsAbs(m.options.CuaPath) {
		return CuaPermissionReading{}, ErrCuaUnavailable
	}
	socket, err := m.ensureCuaService(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return CuaPermissionReading{}, context.Cause(ctx)
		}
		return CuaPermissionReading{}, errors.Join(ErrCuaUnavailable, err)
	}
	environment := append(append(append([]string{}, m.env...), cuaQuietEnvironment...), "CUA_DRIVER_EMBEDDED=1")
	client, err := startClient(ctx, m.options.CuaPath, []string{"mcp", "--socket", socket}, m.options.StateDirectory, environment)
	if err != nil {
		_ = client.close()
		return CuaPermissionReading{}, err
	}
	defer func() { _ = client.close() }()
	result, err := client.request(ctx, "tools/call", map[string]any{"name": checkPermissionsTool, "arguments": map[string]bool{"prompt": false}})
	if err != nil {
		return CuaPermissionReading{}, err
	}
	var reading cuaResult
	if json.Unmarshal(result, &reading) != nil || reading.IsError {
		return CuaPermissionReading{}, errors.New("CuaDriver did not report its permissions")
	}
	return CuaPermissionReading{Accessibility: reading.Structured.Accessibility, ScreenRecording: reading.Structured.ScreenRecording}, nil
}

// cuaGrantLimit bounds a grant flow the owner walked away from.
const cuaGrantLimit = 10 * time.Minute

// RequestCuaPermissions starts `cua-driver permissions grant`, which launches
// CuaDriver through LaunchServices so macOS attributes its prompts to the app.
// CuaDriver refuses to prompt from its tools, where an Agent could reach it;
// only the owner's own step on the permission card reaches this. The flow
// waits for the grants, so it runs in the background, one at a time.
func (m *Manager) RequestCuaPermissions() error {
	if runtime.GOOS != "darwin" || !filepath.IsAbs(m.options.CuaPath) || m.options.CuaEmbedded {
		return ErrCuaUnavailable
	}
	m.cuaGrantMu.Lock()
	defer m.cuaGrantMu.Unlock()
	if m.cuaGrant != nil {
		return nil
	}
	command := exec.Command(m.options.CuaPath, "permissions", "grant")
	command.Env, command.Dir = m.env, m.options.StateDirectory
	if err := command.Start(); err != nil {
		return errors.Join(ErrCuaUnavailable, err)
	}
	m.cuaGrant = command
	limit := time.AfterFunc(cuaGrantLimit, func() { _ = command.Process.Kill() })
	go func() {
		_ = command.Wait()
		limit.Stop()
		m.cuaGrantMu.Lock()
		if m.cuaGrant == command {
			m.cuaGrant = nil
		}
		m.cuaGrantMu.Unlock()
	}()
	return nil
}

func (m *Manager) stopCuaGrant() {
	m.cuaGrantMu.Lock()
	defer m.cuaGrantMu.Unlock()
	if m.cuaGrant != nil {
		_ = m.cuaGrant.Process.Kill()
	}
}

// RestartCua stops the CuaDriver service; the next Cua call starts a new one.
// A trusted embedding host owns its service, so it is left running.
func (m *Manager) RestartCua() error {
	if m.options.CuaEmbedded {
		return nil
	}
	return m.stopCuaService()
}
