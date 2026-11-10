package native

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
)

// codexResidents holds at most one parked app-server per resident key. A
// parked process is the exclusive writer of its thread.
var codexResidents = newResidentTable[*codexProcess]("codex")

var errCodexMaintenanceArg = errors.New("Codex maintenance requires a canonical absolute home")

// codexResidentKey is the Codex home, or a hash of the Runtime and
// executable when no home is managed.
func codexResidentKey(home, runtimeID, executable string) string {
	if home != "" {
		return home
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(runtimeID) + "\n" + executable))
	return hex.EncodeToString(sum[:])
}

func (p *codexProcess) residency() *residency { return &p.res }

func (p *codexProcess) residentAttrs() []any {
	return []any{"pid", p.pid, "thread_id", p.boundThread(), "codex_home", p.home}
}

// codexMismatch names, in reporting order, what keeps a parked process from
// serving an Operation. A change of MCP servers alone stays compatible.
// Skills count only as the Daemon delivered them, never as Codex or an Agent
// later wrote them; the account is read again for every check.
func codexMismatch(profile Profile, spec RunSpec, executable string) func(*codexProcess) []string {
	home := strings.TrimSpace(profile.Env["CODEX_HOME"])
	return func(p *codexProcess) []string {
		var fields []string
		add := func(differs bool, name string) {
			if differs {
				fields = append(fields, name)
			}
		}
		add(!slices.Equal(p.configArgs, profile.CodexConfigArgs), "config_args")
		add(p.dir != spec.Dir, "cwd")
		add(p.model != spec.Model, "model")
		add(p.effort != spec.Effort, "thinking")
		add(p.executable != executable, "exec_path")
		add(p.authPrint != codexAuthFingerprint(home), "auth")
		add(p.skillPrint != profile.ResidentSkillDigest, "skills")
		return fields
	}
}

// StopCodexHomeForMaintenance stops every parked or held process of a
// canonical absolute home. It never starts a process or a turn.
func StopCodexHomeForMaintenance(home string) (bool, error) {
	if home == "" || !filepath.IsAbs(home) || filepath.Clean(home) != home {
		return false, errCodexMaintenanceArg
	}
	count, err := codexResidents.stopWhere("spawn", func(p *codexProcess) bool { return p.home == home }, slog.Default())
	return count > 0 && err == nil, err
}
