package localtools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

// userChromeIdle is how long a connection to the owner's everyday Chrome
// outlives the task that used it. Each new connection makes the extension
// take over a fresh connect page, so without reuse every task of an Agent
// opened another tab and left the previous one behind.
var userChromeIdle = 10 * time.Minute

// userChromeSession is one Playwright child connected through the extension.
// Tasks of the same Agent, owner, Chrome profile, token and workspace take
// turns on it, so the next task continues in the same tab. The seat's slot
// already admits one task at a time, so at most one task holds it.
type userChromeSession struct {
	key string
	// owner, profile and seat name the extension connection the session
	// holds. A seat keeps one relay, so a session of the same seat under
	// another key, or of an owner who disconnects, stops while idle; when the
	// extension keeps one client the seat is the whole profile.
	owner      string
	profile    string
	seat       string
	client     *mcpClient
	directory  string
	socketsDir string
	output     string
	inUse      bool
	idle       *time.Timer
}

func userChromeKey(op *operation, chrome *browserConnection) string {
	sum := sha256.Sum256([]byte(op.spec.TenantID + "\x00" + op.spec.OwnerActorID + "\x00" + op.spec.AgentID + "\x00" + chrome.Profile + "\x00" + chrome.Token + "\x00" + op.spec.WorkingDirectory))
	return hex.EncodeToString(sum[:16])
}

// checkoutUserChrome returns this task's connection to the owner's Chrome,
// reusing an idle one from an earlier task when it is still running.
func (m *Manager) checkoutUserChrome(ctx context.Context, op *operation, chrome *browserConnection) (*userChromeSession, error) {
	key := userChromeKey(op, chrome)
	m.mu.Lock()
	if m.userChromeSessions == nil {
		m.userChromeSessions = map[string]*userChromeSession{}
	}
	existing := m.userChromeSessions[key]
	if existing != nil && !existing.inUse && !existing.client.closed() {
		existing.inUse = true
		if existing.idle != nil {
			existing.idle.Stop()
		}
		m.mu.Unlock()
		return existing, nil
	}
	if existing != nil && !existing.inUse {
		delete(m.userChromeSessions, key)
	} else {
		existing = nil
	}
	m.mu.Unlock()
	if existing != nil {
		if existing.idle != nil {
			existing.idle.Stop()
		}
		m.closeStrayUserChrome(existing)
	}
	op.profileMu.Lock()
	seat := op.chromeSeat
	op.profileMu.Unlock()
	m.closeIdleUserChrome(func(s *userChromeSession) bool { return s.seat == seat })
	session := &userChromeSession{key: key, inUse: true, owner: browserOwner(op.spec.TenantID, op.spec.OwnerActorID), profile: chrome.Profile, seat: seat,
		directory: filepath.Join(m.options.StateDirectory, "computer-tools", "user-chrome", key),
		output:    filepath.Join(op.spec.WorkingDirectory, ".linger", "browser-output", key)}
	if err := privatefs.EnsureDir(session.directory); err != nil {
		return nil, err
	}
	var err error
	if session.socketsDir, err = playwrightSocketsDir(); err != nil {
		return nil, err
	}
	session.client, err = m.startUserChromeBrowser(ctx, chrome, playwrightLaunch{configPath: filepath.Join(session.directory, "browser-user-chrome.json"),
		socketsDir: session.socketsDir, output: session.output, cwd: op.spec.WorkingDirectory})
	if err != nil {
		if !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) {
			_ = os.RemoveAll(session.socketsDir)
		}
		// A start whose cleanup is unconfirmed returns the original child:
		// this task keeps that session, never shared, until its close
		// confirms the cleanup.
		if session.client != nil {
			return session, err
		}
		return nil, err
	}
	m.mu.Lock()
	if m.userChromeSessions[key] == nil {
		m.userChromeSessions[key] = session
	}
	m.mu.Unlock()
	return session, nil
}

// releaseUserChrome ends one task's turn. A healthy connection waits idle for
// the next task; one with an unknown outcome or a rejected token stops now,
// and its cleanup receipt is the task's.
func (m *Manager) releaseUserChrome(session *userChromeSession, healthy bool) error {
	m.mu.Lock()
	session.inUse = false
	shared := m.userChromeSessions[session.key] == session
	if healthy && shared && !m.closingUserChrome {
		session.idle = time.AfterFunc(userChromeIdle, func() { m.expireUserChrome(session) })
		m.mu.Unlock()
		return nil
	}
	if shared {
		delete(m.userChromeSessions, session.key)
	}
	m.mu.Unlock()
	return session.close()
}

func (m *Manager) expireUserChrome(session *userChromeSession) {
	m.mu.Lock()
	if session.inUse || m.userChromeSessions[session.key] != session {
		m.mu.Unlock()
		return
	}
	delete(m.userChromeSessions, session.key)
	m.mu.Unlock()
	m.closeStrayUserChrome(session)
}

// closeIdleUserChrome stops the idle sessions that match, such as those of a
// profile another relay is about to use.
func (m *Manager) closeIdleUserChrome(match func(*userChromeSession) bool) {
	m.mu.Lock()
	var idle []*userChromeSession
	for key, session := range m.userChromeSessions {
		if !session.inUse && match(session) {
			if session.idle != nil {
				session.idle.Stop()
			}
			delete(m.userChromeSessions, key)
			idle = append(idle, session)
		}
	}
	m.mu.Unlock()
	for _, session := range idle {
		m.closeStrayUserChrome(session)
	}
}

func browserOwner(tenantID, ownerActorID string) string {
	return tenantID + "\x00" + ownerActorID
}

// closeStrayUserChrome stops an idle session that no task holds. One whose
// stop is unconfirmed stays with the Manager, so cleanup retries reach it.
func (m *Manager) closeStrayUserChrome(session *userChromeSession) {
	if session.close() != nil {
		m.mu.Lock()
		m.userChromeStray = append(m.userChromeStray, session)
		m.mu.Unlock()
	}
}

// retryStrayUserChrome closes the idle sessions whose stop was unconfirmed
// and keeps those that still do not confirm it.
func (m *Manager) retryStrayUserChrome() error {
	m.mu.Lock()
	stray := m.userChromeStray
	m.userChromeStray = nil
	m.mu.Unlock()
	var errs []error
	for _, session := range stray {
		if err := session.close(); err != nil {
			errs = append(errs, err)
			m.mu.Lock()
			m.userChromeStray = append(m.userChromeStray, session)
			m.mu.Unlock()
		}
	}
	return errors.Join(errs...)
}

// closeUserChrome stops every idle connection when the daemon stops. Tasks
// are closed first, so none is still in use.
func (m *Manager) closeUserChrome() error {
	m.mu.Lock()
	m.closingUserChrome = true
	sessions := make([]*userChromeSession, 0, len(m.userChromeSessions))
	for key, session := range m.userChromeSessions {
		if session.idle != nil {
			session.idle.Stop()
		}
		sessions = append(sessions, session)
		delete(m.userChromeSessions, key)
	}
	m.mu.Unlock()
	var errs []error
	for _, session := range sessions {
		errs = append(errs, session.close())
	}
	return errors.Join(append(errs, m.retryStrayUserChrome())...)
}

// close keeps the sockets directory when the child's exit is unconfirmed.
func (s *userChromeSession) close() error {
	if err := s.client.close(); err != nil {
		return err
	}
	_ = os.RemoveAll(s.socketsDir)
	_ = os.RemoveAll(s.directory)
	return nil
}

// startUserChromeBrowser connects through the Playwright Extension in the
// user's Chrome. Playwright opens Chrome when it is not running; the Agent
// works in its own tab, and the extension shows that the tab is controlled.
func (m *Manager) startUserChromeBrowser(ctx context.Context, chrome *browserConnection, launch playwrightLaunch) (*mcpClient, error) {
	// Without an explicit path Playwright falls back to its own channel lookup,
	// whose failure carries only prose; check the standard location here.
	executable := chromeExecutable(m.env)
	if executable == "" {
		return nil, &BrowserCommandError{"BROWSER_UNAVAILABLE", "Google Chrome was not found at its standard location", false}
	}
	launch.config = map[string]any{}
	launch.args = []string{"--extension", "--profile-dir-name", chrome.Profile, "--executable-path", executable}
	launch.secrets = []string{"PLAYWRIGHT_MCP_EXTENSION_TOKEN=" + chrome.Token}
	// The relay starts a stopped Chrome detached. Owning only the relay keeps
	// that Chrome open after the task, including outside the Windows job.
	launch.run = process.RunDirectChild
	return m.startPlaywright(ctx, launch)
}

// startUserChromeBrowser starts a connection owned by this Operation alone,
// as the connection check does.
func (op *operation) startUserChromeBrowser(ctx context.Context, chrome *browserConnection) (*mcpClient, error) {
	if op.playwrightSocketsDir == "" {
		var err error
		if op.playwrightSocketsDir, err = playwrightSocketsDir(); err != nil {
			return nil, err
		}
	}
	return op.manager.startUserChromeBrowser(ctx, chrome, playwrightLaunch{configPath: filepath.Join(op.directory, "browser-user-chrome.json"),
		socketsDir: op.playwrightSocketsDir, output: op.browserOutput(), cwd: op.spec.WorkingDirectory})
}
