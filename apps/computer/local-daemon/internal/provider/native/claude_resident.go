package native

import (
	"log/slog"
	"strings"
)

// claudeResidents keys each Claude process by its session root: parked, or
// held while its tree is not yet confirmed gone.
var claudeResidents = newResidentTable[*claudeProcess]("claude")

// claudeShape is what a running process has baked in. Only a process with a
// shape can be reused.
type claudeShape struct {
	execPath   string
	cwd        string
	args       []string
	env        []string
	initialize string
	mcp        string
}

// differs names the shape fields that differ from want, in the order the
// mismatch log uses. Values are never reported: they can hold URLs, tokens
// or env. The MCP set is a Run's attachment, connected when a process is
// taken, so it never keeps a process from serving.
func (s *claudeShape) differs(want *claudeShape) []string {
	var fields []string
	add := func(differs bool, name string) {
		if differs {
			fields = append(fields, name)
		}
	}
	add(s.execPath != want.execPath, "exec_path")
	add(s.cwd != want.cwd, "cwd")
	add(strings.Join(s.args, "\x00") != strings.Join(want.args, "\x00"), "args")
	add(strings.Join(s.env, "\x00") != strings.Join(want.env, "\x00"), "env")
	add(s.initialize != want.initialize, "initialize")
	return fields
}

// claudeMismatch applies the Claude reuse rules against want for spec. A
// pre-start serves only the session it was spawned for, in the same create
// or resume mode.
func claudeMismatch(want *claudeShape, spec RunSpec) func(*claudeProcess) []string {
	return func(p *claudeProcess) []string {
		if p.shape == nil {
			return []string{"shape"}
		}
		p.mu.Lock()
		session, created := p.sessionID, p.prestartCreated
		p.mu.Unlock()
		prestart := p.res.isPrestart()
		fields := p.shape.differs(want)
		switch {
		case prestart && created:
			if spec.AssignSessionID != session || spec.ResumeID != "" {
				fields = append(fields, "session")
			}
		case prestart:
			if spec.AssignSessionID != "" || spec.ResumeID != session {
				fields = append(fields, "session")
			}
		default:
			if spec.AssignSessionID != "" {
				fields = append(fields, "create_session")
			}
			if spec.ResumeID == "" || spec.ResumeID != session {
				fields = append(fields, "session")
			}
		}
		return fields
	}
}

// claudeShapeEnv is the child environment without the temp variables, which
// may differ per Operation without changing the process.
func claudeShapeEnv(env []string) []string {
	var out []string
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=")
		if strings.EqualFold(name, "TMPDIR") || strings.EqualFold(name, "TMP") || strings.EqualFold(name, "TEMP") {
			continue
		}
		out = append(out, entry)
	}
	return out
}

func (p *claudeProcess) residency() *residency { return &p.res }

func (p *claudeProcess) residentAttrs() []any {
	p.mu.Lock()
	session := p.sessionID
	p.mu.Unlock()
	return []any{"pid", p.pid, "session_id", session}
}

// claudeSettle records the end of a process's reader in the table.
func claudeSettle(p *claudeProcess, confirmed bool) {
	if confirmed {
		claudeResidents.forget(p)
		return
	}
	claudeResidents.hold(p)
}

// park ends the turn on a clean result and keeps the process for the next
// turn on the same session root.
func (t *claudeTurn) park() bool {
	p := t.proc
	terminal := t.terminal
	completed := terminal != nil && (terminal.TerminalReason == "completed" || t.compaction && terminal.TerminalReason == "")
	if p.shape == nil || !completed || terminal.IsError ||
		t.background || t.observedSession == "" || !claudeResidents.enabled() || !p.conv.idle() || !t.submittedOK() {
		return false
	}
	p.mu.Lock()
	if p.stopping || p.ctx.Err() != nil || t.runCtx.Err() != nil || p.turn != t {
		p.mu.Unlock()
		return false
	}
	p.turn = nil
	p.sessionID = t.observedSession
	t.endLocked()
	p.mu.Unlock()
	p.front.Unbind()
	outcome := t.compute(claudeEnding{parked: true})
	if !claudeResidents.park(p, t.fence, false, t.logger, t.spec.Readiness) {
		t.logger.Warn("claude resident park failed", "pid", p.pid)
		claudeResidents.hold(p)
		p.mu.Lock()
		p.stopping = true
		p.mu.Unlock()
		p.cancel()
	}
	t.deliver(outcome)
	return true
}

// StopParkedClaudeResidentForCredentials stops the process of a Runtime
// home's session root before its Claude login changes.
func StopParkedClaudeResidentForCredentials(sessionRoot string) error {
	root := claudeCleanRoot(sessionRoot)
	if root == "" {
		return nil
	}
	_, err := claudeResidents.stopWhere("credentials_changed", func(p *claudeProcess) bool { return p.res.key == root }, slog.Default())
	return err
}
