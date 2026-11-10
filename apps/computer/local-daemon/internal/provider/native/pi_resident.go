package native

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// piResidents keys each Pi process by its session directory: parked, or
// held while its tree is not yet confirmed gone.
var piResidents = newResidentTable[*piProcess]("pi")

// piResidentStore is the Pi resident table as the cross-provider stop
// functions see it.
func piResidentStore() residentStore { return piResidents }

// piShape is what a running Pi process has baked in. Only a process with a
// shape can park.
type piShape struct {
	execPath        string
	cwd             string
	args            string
	env             string
	systemPrompt    string
	skills          string
	settings        string
	projectSettings string
	mcp             string
}

// mismatches names the fields that keep a parked process from serving spec.
// Values are never reported.
func (s *piShape) mismatches(want *piShape, spec RunSpec, parkedSession string) []string {
	var fields []string
	add := func(differs bool, name string) {
		if differs {
			fields = append(fields, name)
		}
	}
	add(s.execPath != want.execPath, "exec_path")
	add(s.cwd != want.cwd, "cwd")
	add(s.args != want.args, "args")
	add(s.env != want.env, "env")
	add(s.systemPrompt != want.systemPrompt, "system_prompt")
	add(s.skills != want.skills, "skills")
	add(s.settings != want.settings, "settings")
	add(s.projectSettings != want.projectSettings, "project_settings")
	add(s.mcp != want.mcp, "mcp")
	add(spec.AssignSessionID != "", "create_session")
	add(spec.ResumeID == "" || spec.ResumeID != parkedSession, "session")
	return fields
}

func piMismatch(want *piShape, spec RunSpec) func(*piProcess) []string {
	return func(p *piProcess) []string {
		if p.shape == nil {
			return []string{"shape"}
		}
		return p.shape.mismatches(want, spec, p.sessionID)
	}
}

// piShapeFor computes the reuse shape of a launch. args is the launch argv
// without the session flags, with the instruction path as a placeholder.
func piShapeFor(program string, args []string, profile Profile, spec RunSpec, mcpShape string) (*piShape, error) {
	project, err := piFileFingerprint(filepath.Join(spec.Dir, ".pi", "settings.json"))
	if err != nil {
		return nil, err
	}
	prompt := sha256.Sum256([]byte(spec.AppendPrompt))
	return &piShape{
		execPath:        program,
		cwd:             spec.Dir,
		args:            strings.Join(args, "\x00"),
		env:             strings.Join(piShapeEnv(childEnvironment(profile.Env)), "\x00"),
		systemPrompt:    hex.EncodeToString(prompt[:]),
		skills:          profile.ResidentSkillDigest,
		settings:        profile.PiConfigDigest,
		projectSettings: project,
		mcp:             mcpShape,
	}, nil
}

// piShapeEnv drops the temp variables: reused turns inherit the spawning
// turn's temp directory, so they never decide reuse.
func piShapeEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(name) {
		case "TMPDIR", "TMP", "TEMP":
			continue
		}
		out = append(out, entry)
	}
	return out
}

// piFileFingerprint hashes one file; a missing file hashes as empty.
func piFileFingerprint(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("Pi project settings could not be read: %w", err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
