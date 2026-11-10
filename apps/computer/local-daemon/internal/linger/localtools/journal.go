package localtools

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
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
}

type actionJournal struct {
	mu     sync.Mutex
	path   string
	active *actionIdentity
	slot   chan struct{}
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
	j.active = stored.Active
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
	if j.active != nil {
		<-j.slot
		return nil, errors.New("COMPUTER_ACTION_UNKNOWN: an earlier action has no verified cleanup receipt; input remains blocked")
	}
	identity.Nonce = rand.Text()
	if err := j.persist(&identity); err != nil {
		<-j.slot
		return nil, err
	}
	j.active = &identity
	return &actionReceipt{journal: j, nonce: identity.Nonce}, nil
}

func (j *actionJournal) persist(active *actionIdentity) error {
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

func (j *actionJournal) blocked() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.active != nil
}
