package localtools

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

type liveBrowserSession struct {
	op      *operation
	catalog *toolCatalog
	used    time.Time
}

// CallLiveBrowser uses the same native browser profile and journal as task
// operations. No cloud desktop and no Codex/Claude process is involved.
func (m *Manager) CallLiveBrowser(ctx context.Context, tenantID, ownerID, agentID, sessionID, name string, args json.RawMessage) (json.RawMessage, error) {
	if err := m.lockLive(ctx); err != nil {
		return nil, err
	}
	defer m.unlockLive()
	if m.journal == nil {
		return nil, errors.New("native browser tools are unavailable")
	}
	if tenantID == "" || ownerID == "" || agentID == "" || sessionID == "" {
		return nil, errors.New("browser scope is incomplete")
	}
	if m.liveSessions == nil {
		m.liveSessions = map[string]*liveBrowserSession{}
	}
	for key, session := range m.liveSessions {
		if time.Since(session.used) > 5*time.Minute {
			// An unconfirmed cleanup keeps the Operation for retryCleanup;
			// the session must still go, or every later call fails here.
			_ = session.op.close()
			delete(m.liveSessions, key)
		}
	}
	key := tenantID + "\x00" + ownerID + "\x00" + agentID + "\x00" + sessionID
	// The owner talks in one Live call at a time: an earlier call's session
	// would keep their Chrome from this one.
	owner := tenantID + "\x00" + ownerID + "\x00"
	for other, session := range m.liveSessions {
		if other != key && strings.HasPrefix(other, owner) {
			_ = session.op.close()
			delete(m.liveSessions, other)
		}
	}
	session := m.liveSessions[key]
	if session == nil {
		if len(m.liveSessions) >= 16 {
			return nil, errors.New("too many browser sessions")
		}
		sum := sha256.Sum256([]byte(key))
		// A session whose cleanup failed may still own its directory, so a
		// new session of the same key never reuses it.
		directory := filepath.Join(m.options.StateDirectory, "computer-tools", "live", hex.EncodeToString(sum[:])+"-"+rand.Text())
		if err := privatefs.EnsureDir(directory); err != nil {
			return nil, err
		}
		opCtx, cancel := context.WithCancel(context.Background())
		op := &operation{manager: m, live: true, directory: directory, ctx: opCtx, cancel: cancel, label: "linger-" + rand.Text(), spec: provider.OperationSpec{TenantID: tenantID, OwnerActorID: ownerID, AgentID: agentID, WorkingDirectory: directory}, identity: mcpproxy.OperationIdentity{OperationID: sessionID}}
		var err error
		op.userChrome, err = m.loadBrowserConnection(tenantID, ownerID)
		if err != nil {
			cancel()
			return nil, err
		}
		if op.userChrome != nil && op.userChrome.State == browserTokenInvalid {
			op.userChromeRejected.Store(true)
		}
		op.chromeRequired = op.userChrome == nil && m.everydayChrome()
		catalog, err := m.toolCatalog(ctx, op)
		if err != nil {
			return nil, errors.Join(err, op.close())
		}
		session = &liveBrowserSession{op: op, catalog: catalog}
		m.liveSessions[key] = session
		m.mu.Lock()
		m.operations[op] = true
		m.mu.Unlock()
	}
	session.used = time.Now()
	for _, tool := range session.catalog.browser {
		if tool.Name == name {
			return session.op.wrap(session.op.browserCall)(ctx, name, args)
		}
	}
	return nil, errors.New("browser tool is not offered")
}

// lockLive admits one Live browser call at a time. A call that waits longer
// than its caller gives up and never runs later.
func (m *Manager) lockLive(ctx context.Context) error {
	select {
	case m.liveSlots() <- struct{}{}:
		return nil
	case <-ctx.Done():
		return context.Cause(ctx)
	}
}

func (m *Manager) tryLockLive() bool {
	select {
	case m.liveSlots() <- struct{}{}:
		return true
	default:
		return false
	}
}

func (m *Manager) unlockLive() { <-m.liveSlots() }

func (m *Manager) liveSlots() chan struct{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.liveSlot == nil {
		m.liveSlot = make(chan struct{}, 1)
	}
	return m.liveSlot
}

// releaseIdleLiveChrome closes the Live browser sessions that hold profile
// between calls, so a task waiting for the owner's Chrome gets it. A Live
// call in progress keeps it: it holds the Live slot, and so does the call
// that asks.
func (m *Manager) releaseIdleLiveChrome(profile string) {
	if !m.tryLockLive() {
		return
	}
	defer m.unlockLive()
	for key, session := range m.liveSessions {
		if !session.op.holdsChromeProfile(profile) {
			continue
		}
		// An unconfirmed cleanup keeps the profile until retryCleanup
		// confirms it; the session is gone either way.
		_ = session.op.close()
		delete(m.liveSessions, key)
	}
}

func (op *operation) holdsChromeProfile(profile string) bool {
	op.connectMu.Lock()
	chrome := op.userChrome
	op.connectMu.Unlock()
	op.profileMu.Lock()
	defer op.profileMu.Unlock()
	return op.releaseProfile != nil && chrome != nil && chrome.Profile == profile
}
