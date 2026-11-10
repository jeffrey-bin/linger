package selfupdate

// Handoff asks the process to replace itself with another bundle's daemon once
// its deferred shutdown, including instance lease release, has completed.
type Handoff struct {
	Path string
	Args []string
	Env  []string
}

func (h *Handoff) Error() string {
	return "Local Computer Daemon hands off to " + h.Path
}

// Exec replaces the current process image. The PID and process group stay the
// same, so supervisors and detached launchers keep tracking the daemon.
func (h *Handoff) Exec() error {
	return execProcess(h.Path, h.Args, h.Env)
}
