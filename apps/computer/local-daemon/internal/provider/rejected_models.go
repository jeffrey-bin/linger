package provider

import (
	"fmt"
	"os"
	"sync"
	"time"
)

// rejectedModelTTL bounds how long a refusal hides a model when the login
// cannot be fingerprinted, for example a Claude login kept in the macOS
// keychain.
const rejectedModelTTL = 24 * time.Hour

// RejectedModels remembers the models a Runtime's current login refused, so
// the Computer stops offering them. A Run whose Runtime reported a structured
// model-unavailable signal (Claude's model_not_found) marks the model; Codex
// has no such signal, so its refusals are not detected. A changed login file
// or the time limit makes the model selectable again; a restarted Daemon
// offers every model again.
type RejectedModels struct {
	mu          sync.Mutex
	now         func() time.Time
	fingerprint func(runtimeType string) string
	rejected    map[string]map[string]modelRejection
}

type modelRejection struct {
	at          time.Time
	fingerprint string
}

// NewRejectedModels fingerprints each Runtime's login by the metadata of its
// credential file, never its contents.
func NewRejectedModels(credentialFiles map[string]string) *RejectedModels {
	return &RejectedModels{
		now: time.Now,
		fingerprint: func(runtimeType string) string {
			path := credentialFiles[runtimeType]
			if path == "" {
				return ""
			}
			info, err := os.Stat(path)
			if err != nil {
				return ""
			}
			return fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
		},
		rejected: make(map[string]map[string]modelRejection),
	}
}

func (r *RejectedModels) Reject(runtimeType, modelID string) {
	if runtimeType == "" || modelID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.rejected[runtimeType] == nil {
		r.rejected[runtimeType] = make(map[string]modelRejection)
	}
	r.rejected[runtimeType][modelID] = modelRejection{at: r.now(), fingerprint: r.fingerprint(runtimeType)}
}

// Filter returns the diagnostics without models the current login refused. A
// known empty catalog remains empty; Agent Service must not refill it.
func (r *RejectedModels) Filter(diagnostics []RuntimeDiagnostic) []RuntimeDiagnostic {
	r.mu.Lock()
	defer r.mu.Unlock()
	filtered := append([]RuntimeDiagnostic(nil), diagnostics...)
	for index, diagnostic := range filtered {
		rejected := r.current(diagnostic.Type)
		if len(rejected) == 0 {
			continue
		}
		models := make([]RuntimeModel, 0, len(diagnostic.Models))
		for _, model := range diagnostic.Models {
			if !rejected[model.ID] {
				models = append(models, model)
			}
		}
		filtered[index].Models = models
	}
	return filtered
}

// Expire forgets refusals from an earlier login or past the time limit and
// reports whether any model became selectable again.
func (r *RejectedModels) Expire() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	expired := false
	for runtimeType, entries := range r.rejected {
		before := len(entries)
		expired = len(r.current(runtimeType)) < before || expired
	}
	return expired
}

func (r *RejectedModels) current(runtimeType string) map[string]bool {
	entries := r.rejected[runtimeType]
	if len(entries) == 0 {
		return nil
	}
	fingerprint := r.fingerprint(runtimeType)
	current := make(map[string]bool, len(entries))
	for modelID, rejection := range entries {
		if rejection.fingerprint != fingerprint || r.now().Sub(rejection.at) >= rejectedModelTTL {
			delete(entries, modelID)
			continue
		}
		current[modelID] = true
	}
	return current
}
