package control

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const (
	lockDirectoryName = "daemon.lock"
	leaseLockName     = "daemon-instance.lock"
	ownerFileName     = "owner.json"
	claimTimeout      = 100 * time.Millisecond
)

type Owner struct {
	PID            int    `json:"pid"`
	ProcessGroupID int    `json:"processGroupId"`
	StartTime      string `json:"startTime"`
	Nonce          string `json:"nonce"`
}

// Lease is the single-instance claim of the resident daemon on its state
// directory: an OS file lock, which the OS releases when the process exits.
type Lease struct {
	lock          *os.File
	lockDirectory string
	owner         Owner
	released      bool
}

// AcquireLease claims the single daemon instance for an absolute state
// directory and records its owner marker.
func AcquireLease(ctx context.Context, stateDirectory string) (*Lease, error) {
	if !filepath.IsAbs(stateDirectory) {
		return nil, errors.New("Daemon state directory must be absolute")
	}
	if err := privatefs.EnsureDir(stateDirectory); err != nil {
		return nil, err
	}
	identity, err := currentProcessIdentity(ctx)
	if err != nil {
		return nil, fmt.Errorf("establish Daemon process identity: %w", err)
	}
	if identity.PID != identity.ProcessGroupID {
		return nil, fmt.Errorf(
			"Local Computer Daemon must own its process group (pid=%d process_group_id=%d)",
			identity.PID, identity.ProcessGroupID,
		)
	}
	nonce, err := randomNonce()
	if err != nil {
		return nil, err
	}
	owner := Owner{
		PID: identity.PID, ProcessGroupID: identity.ProcessGroupID,
		StartTime: identity.StartTime, Nonce: nonce,
	}
	lock, err := claim(ctx, filepath.Join(stateDirectory, leaseLockName))
	if err != nil {
		return nil, err
	}
	lockDirectory := filepath.Join(stateDirectory, lockDirectoryName)
	if err := writeOwner(lockDirectory, owner); err != nil {
		privatefs.ReleaseLock(lock)
		return nil, err
	}
	return &Lease{lock: lock, lockDirectory: lockDirectory, owner: owner}, nil
}

// Release gives up the single-instance claim; the OS also releases it when
// the process ends.
func (l *Lease) Release(context.Context) error {
	if l == nil || l.released {
		return nil
	}
	var releaseErrors []error
	current, err := readOwner(l.lockDirectory)
	if err == nil && current.PID == l.owner.PID && current.Nonce == l.owner.Nonce {
		if err := os.RemoveAll(l.lockDirectory); err != nil {
			releaseErrors = append(releaseErrors, err)
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		releaseErrors = append(releaseErrors, err)
	}
	if err := l.lock.Close(); err != nil {
		releaseErrors = append(releaseErrors, err)
	}
	l.released = true
	return errors.Join(releaseErrors...)
}

// claim takes the lock without blocking, retrying briefly so a Daemon that
// is exiting for a restart can let go first.
func claim(ctx context.Context, path string) (*os.File, error) {
	deadline := time.Now().Add(claimTimeout)
	for {
		lock, acquired, err := privatefs.AcquireLock(path)
		if err != nil {
			return nil, err
		}
		if acquired {
			return lock, nil
		}
		if !time.Now().Before(deadline) {
			return nil, errors.New("Local Computer Daemon is already running")
		}
		timer := time.NewTimer(min(5*time.Millisecond, time.Until(deadline)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func writeOwner(lockDirectory string, owner Owner) error {
	if err := os.RemoveAll(lockDirectory); err != nil {
		return err
	}
	if err := privatefs.EnsureDir(lockDirectory); err != nil {
		return err
	}
	encoded, err := json.Marshal(owner)
	if err != nil {
		return err
	}
	return privatefs.WriteFile(filepath.Join(lockDirectory, ownerFileName), encoded, true)
}

func readOwner(lockDirectory string) (Owner, error) {
	content, err := privatefs.ReadFile(filepath.Join(lockDirectory, ownerFileName), 1024*1024)
	if err != nil {
		return Owner{}, err
	}
	var owner Owner
	if json.Unmarshal(content, &owner) != nil || owner.PID < 1 || owner.ProcessGroupID < 1 || owner.StartTime == "" || owner.Nonce == "" {
		return Owner{}, errors.New("Daemon owner marker is invalid")
	}
	return owner, nil
}

func randomNonce() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	encoded := hex.EncodeToString(value[:])
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}
