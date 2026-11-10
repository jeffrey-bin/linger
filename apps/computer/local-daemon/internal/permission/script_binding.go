package permission

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
)

// scriptApprovalBinding is how long an allowed Skill script call waits for its
// run: a run follows its review within seconds, or after another task's input.
const scriptApprovalBinding = 5 * time.Minute

// approvedScripts holds one entry for each run_script call the judge allowed,
// keyed by its ScriptScope, its script path, the digest of the body the judge
// read, and its args. A run takes one entry, so each review allows one run,
// and only a run of the same Agent and Context. Reviews and runs happen in one
// Daemon process.
var approvedScripts = struct {
	sync.Mutex
	entries map[string][]time.Time
}{entries: map[string][]time.Time{}}

// ScriptScope names the Agent and Context a Skill script review belongs to.
// A Context runs one Run at a time, and its prepare and Run share it.
func ScriptScope(agentID, contextID string) string {
	return agentID + "\x00" + contextID
}

func scriptApprovalKey(scope, path, sha string, args any) (string, bool) {
	encoded, err := json.Marshal(args)
	if err != nil || scope == "" {
		return "", false
	}
	sum := sha256.Sum256([]byte(scope + "\x00" + path + "\x00" + sha + "\x00" + string(encoded)))
	return hex.EncodeToString(sum[:]), true
}

// recordApprovedScript keeps an allowed run_script call of a Skill script,
// with the body the judge reviewed and the args it saw.
func recordApprovedScript(scope string, request Request, now time.Time) {
	if !strings.HasSuffix(request.Action.Tool, "run_script") || request.Evidence == nil || request.Evidence.Script == nil || request.Evidence.Script.SHA256 == "" {
		return
	}
	var input map[string]any
	if json.Unmarshal([]byte(request.Action.Input), &input) != nil {
		return
	}
	key, ok := scriptApprovalKey(scope, request.Evidence.Script.Path, request.Evidence.Script.SHA256, input["args"])
	if !ok {
		return
	}
	approvedScripts.Lock()
	defer approvedScripts.Unlock()
	for k, times := range approvedScripts.entries {
		kept := times[:0]
		for _, at := range times {
			if now.Sub(at) <= scriptApprovalBinding {
				kept = append(kept, at)
			}
		}
		if len(kept) == 0 {
			delete(approvedScripts.entries, k)
		} else {
			approvedScripts.entries[k] = kept
		}
	}
	approvedScripts.entries[key] = append(approvedScripts.entries[key], now)
}

// TakeApprovedScript lets a reviewed Run execute a Skill script only as the
// judge allowed it in the same scope: the same body, read now, and the same
// args, within the binding time. It uses up that allow, so the next run is reviewed again.
func TakeApprovedScript(scope, path, body string, args any, now time.Time) error {
	sum := sha256.Sum256([]byte(body))
	key, ok := scriptApprovalKey(scope, path, hex.EncodeToString(sum[:]), args)
	if !ok {
		return errors.New("COMPUTER_SCRIPT_REFUSED: run_script args are not JSON, or the Run has no Context")
	}
	approvedScripts.Lock()
	defer approvedScripts.Unlock()
	for i, at := range approvedScripts.entries[key] {
		if now.Sub(at) <= scriptApprovalBinding {
			times := approvedScripts.entries[key]
			approvedScripts.entries[key] = append(times[:i:i], times[i+1:]...)
			return nil
		}
	}
	return errors.New("COMPUTER_SCRIPT_REFUSED: this run_script call does not match a reviewed one, because script_file changed after its review or the review expired; call it again so it is reviewed")
}
