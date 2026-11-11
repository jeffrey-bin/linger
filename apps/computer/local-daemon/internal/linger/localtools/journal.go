package localtools

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

type actionIdentity struct {
	Nonce       string `json:"nonce"`
	AgentID     string `json:"agent_id"`
	OperationID string `json:"operation_id"`
	Session     string `json:"session"`
	// Background marks a desktop input that needed neither the front window
	// nor the clipboard; see focusGate. Any other unknown desktop input,
	// including a record without the field, also blocks browser calls until
	// it settles.
	Background bool `json:"background,omitempty"`
}

type actionJournal struct {
	mu     sync.Mutex
	path   string
	active *actionIdentity
	// restored marks an active record read from disk: an earlier Daemon left
	// it, so no task of this one holds its receipt. Only the user settles it,
	// by removing the file once they know the action finished.
	restored bool
	slot     chan struct{}
}

type actionReceipt struct {
	journal *actionJournal
	nonce   string
	release sync.Once
}

func openJournal(path string) (*actionJournal, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("local tool state requires an absolute path")
	}
	if err := privatefs.EnsureDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	j := &actionJournal{path: path, slot: make(chan struct{}, 1)}
	data, err := privatefs.ReadFile(path, 64*1024)
	if errors.Is(err, os.ErrNotExist) {
		return j, nil
	}
	if err != nil {
		return nil, err
	}
	var stored struct {
		Version int             `json:"version"`
		Active  *actionIdentity `json:"active"`
	}
	if json.Unmarshal(data, &stored) != nil || stored.Version != 1 || (stored.Active != nil && stored.Active.Nonce == "") {
		return nil, errors.New("invalid local tool action state; input remains blocked")
	}
	j.active, j.restored = stored.Active, stored.Active != nil
	return j, nil
}

func (j *actionJournal) begin(ctx context.Context, identity actionIdentity) (*actionReceipt, error) {
	select {
	case j.slot <- struct{}{}:
	case <-ctx.Done():
		return nil, context.Cause(ctx)
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := ctx.Err(); err != nil {
		<-j.slot
		return nil, context.Cause(ctx)
	}
	if j.pendingLocked() {
		<-j.slot
		return nil, errors.New("COMPUTER_ACTION_UNKNOWN: an earlier action has no verified cleanup receipt; this desktop, Agent browser or everyday Chrome seat stays blocked until it settles")
	}
	identity.Nonce = rand.Text()
	if err := j.persist(&identity); err != nil {
		<-j.slot
		return nil, err
	}
	j.active, j.restored = &identity, false
	return &actionReceipt{journal: j, nonce: identity.Nonce}, nil
}

// persist records active, or removes the record once nothing is pending, so
// the record of an Agent's browser that is never used again leaves no file.
func (j *actionJournal) persist(active *actionIdentity) error {
	if active == nil {
		if err := os.Remove(j.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	} else {
		data, err := json.Marshal(struct {
			Version int             `json:"version"`
			Active  *actionIdentity `json:"active"`
		}{1, active})
		if err != nil {
			return err
		}
		if err := privatefs.WriteFile(j.path, data, false); err != nil {
			return err
		}
	}
	// Windows cannot open a directory for flushing; NTFS journals the rename.
	if runtime.GOOS == "windows" {
		return nil
	}
	dir, err := os.Open(filepath.Dir(j.path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// A false receipt releases the queue but retains the durable block. Only this
// live owner can later complete it after verified downstream cleanup. A new
// daemon has no receipt, so a different Cua transport cannot clear old work.
func (r *actionReceipt) finish(confirmed bool) error {
	if r == nil {
		return nil
	}
	j := r.journal
	j.mu.Lock()
	var err error
	if confirmed && j.active != nil && j.active.Nonce == r.nonce {
		err = j.persist(nil)
		if err == nil {
			j.active = nil
		}
	}
	j.mu.Unlock()
	r.release.Do(func() { <-j.slot })
	return err
}

// unknownAction describes the unknown action this journal holds, or returns
// "" when it holds none.
func (j *actionJournal) unknownAction() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.pendingLocked() {
		return ""
	}
	if j.restored {
		return fmt.Sprintf("Agent %q left it in %s before the Daemon restarted; no task settles it; remove that file once the action is known to be finished", j.active.AgentID, j.path)
	}
	return fmt.Sprintf("Agent %q left it in %s; it settles when that task ends", j.active.AgentID, j.path)
}

func (j *actionJournal) blocked() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.pendingLocked()
}

// pendingLocked reports an active record. A restored record whose file the
// user removed is dropped; any other failure to look keeps it. The caller
// holds j.mu.
func (j *actionJournal) pendingLocked() bool {
	if j.active == nil {
		return false
	}
	if j.restored {
		if _, err := os.Lstat(j.path); errors.Is(err, os.ErrNotExist) {
			j.active, j.restored = nil, false
			return false
		}
	}
	return true
}

// blocksFocus reports an unknown desktop input that a browser call bringing
// Chrome forward or using the clipboard could still meet.
func (j *actionJournal) blocksFocus() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.pendingLocked() && !j.active.Background
}
