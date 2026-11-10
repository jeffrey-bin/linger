package permission

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
)

// ShellDecision is the Daemon's own answer to a shell command.
type ShellDecision int

const (
	// ShellReview sends the command to the permission review.
	ShellReview ShellDecision = iota
	// ShellAllow runs it: each step only reads, is an allowed or confirmed
	// TeamHub command, or is a local step that stays in the workspace. A
	// confirmed command still asks the sponsor itself before its write.
	ShellAllow
	// ShellRunAlone refuses it: it mixes a confirmed TeamHub command with
	// steps that need review, so the sponsor's own confirmation card would
	// follow a review card for the same write. The Agent runs that command
	// on its own instead.
	ShellRunAlone
)

// Shell decides a shell command made of read-only commands, TeamHub CLI
// commands, and local steps, alone or chained by &&, ||, ;, | and newlines.
// It reads only a small shell subset: plain words, single quotes, double
// quotes without expansion, quoted heredocs, line continuations, and
// redirections to files. Anything else goes to the review, and so do local
// writes without a TeamHub step: they prepare a TeamHub command, and on
// their own may write a script or hook the next command runs. cwd is the
// directory the command runs in, or empty when the Runtime does not report
// it; relative paths then go to the review too. The returned name is the
// confirmed TeamHub command for ShellRunAlone.
func Shell(command, cwd, workspace string, commands []TeamHubCommand) (ShellDecision, string) {
	steps, ok := parseShell(command)
	if !ok {
		return ShellReview, ""
	}
	paths := shellPaths{workspace: workspace, places: []string{cwd}}
	teamhub, writes, review, confirm := false, false, false, ""
	for _, step := range steps {
		switch {
		case step.words[0] == "teamhub":
			teamhub = true
			allowed := teamhubCommand(step.words, commands)
			switch {
			case allowed == nil || !paths.redirects(step):
				review = true
			case allowed.Confirm && confirm == "":
				confirm = "teamhub " + strings.Join(allowed.Path, " ")
			}
		case paths.cd(step):
		case readOnlyStep(step):
			if step.words[0] == "cd" {
				// It left the workspace or the known directory, so relative
				// paths after it are reviewed.
				paths.places = append(paths.places, "")
			}
		case paths.write(step):
			writes = true
		default:
			review = true
		}
	}
	switch {
	case review && confirm != "":
		return ShellRunAlone, confirm
	case review, writes && !teamhub:
		return ShellReview, ""
	}
	return ShellAllow, ""
}

// tccutil resets privacy grants; an AppleScript aimed at System Settings can
// switch a grant on. The check matches program names and bundle ids, never
// prose, and reads the raw command because a heredoc or a nested shell hides
// the script from parseShell.
var (
	tccutilCommand  = regexp.MustCompile(`(^|[^A-Za-z0-9_.-])tccutil([^A-Za-z0-9_.-]|$)`)
	privacySettings = []string{"System Settings", "System Preferences", "com.apple.preference.security", "com.apple.systempreferences", "x-apple.systempreferences"}
)

// SystemPrivacyUI reports whether a shell command changes macOS privacy
// grants or drives the System Settings app, which only the user may do.
func SystemPrivacyUI(command string) bool {
	if tccutilCommand.MatchString(command) {
		return true
	}
	if !strings.Contains(command, "osascript") {
		return false
	}
	for _, target := range privacySettings {
		if strings.Contains(command, target) {
			return true
		}
	}
	return false
}

// SystemPrivacyUIMessage tells the Agent how to get a missing permission
// instead.
const SystemPrivacyUIMessage = "SYSTEM_PRIVACY_UI_PROTECTED: this command did not run. Only the user changes macOS privacy permissions. Run `teamhub computer permissions request` to post a permission card for them, then end your turn; the card wakes you once they grant it."

// RunAloneMessage tells the Agent why a mixed command did not run.
func RunAloneMessage(confirm string) string {
	return "This command did not run: it combines `" + confirm + "`, which asks the sponsor to confirm its write, with steps that need a permission review. Run `" + confirm + "` as its own command, and the other steps as separate commands."
}

// teamhubCommand returns the longest allowed command path the words start
// with, or nil.
func teamhubCommand(words []string, commands []TeamHubCommand) *TeamHubCommand {
	var match *TeamHubCommand
	for index, command := range commands {
		if len(words) > len(command.Path) && slices.Equal(words[1:1+len(command.Path)], command.Path) &&
			(match == nil || len(command.Path) > len(match.Path)) {
			match = &commands[index]
		}
	}
	return match
}

type shellStep struct {
	words     []string
	redirects []shellRedirect
	// heredoc is set when stdin is a quoted heredoc, whose body is literal.
	heredoc bool
	pipeIn  bool
	pipeOut bool
}

type shellRedirect struct {
	op, target string
}

// shellWordByte is a byte that is literal in an unquoted shell word. Bytes
// of multi-byte UTF-8 characters are literal too.
func shellWordByte(c byte) bool {
	return c >= 0x80 || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("_./:@,+=%-", c) >= 0
}

var heredocDelimiter = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

type heredocMark struct {
	delimiter string
	stripTabs bool
}

// parseShell splits a command into its simple commands, or reports false
// for anything outside the subset Shell reads.
func parseShell(command string) ([]shellStep, bool) {
	var steps []shellStep
	var current shellStep
	var pending []heredocMark
	// joined is set after an operator that needs a following command.
	joined := false
	end := func(pipe bool) bool {
		if len(current.words) == 0 {
			return false
		}
		current.pipeOut = pipe
		steps = append(steps, current)
		current = shellStep{pipeIn: pipe}
		joined = true
		return true
	}
	for i := 0; i < len(command); {
		c := command[i]
		next := byte(0)
		if i+1 < len(command) {
			next = command[i+1]
		}
		switch {
		case c == ' ' || c == '\t':
			i++
		case c == '\\' && next == '\n':
			i += 2
		case c == '\n':
			if len(current.words) > 0 {
				end(false)
				joined = false
			} else if len(current.redirects) > 0 {
				return nil, false
			}
			i++
			for _, mark := range pending {
				var ok bool
				if i, ok = skipHeredoc(command, i, mark); !ok {
					return nil, false
				}
			}
			pending = nil
		case c == ';':
			if !end(false) {
				return nil, false
			}
			i++
		case c == '&' && next == '&', c == '|' && next == '|':
			if !end(false) {
				return nil, false
			}
			i += 2
		case c == '|' && next != '&':
			if !end(true) {
				return nil, false
			}
			i++
		case c == '>' || c == '<' || c == '&' && next == '>' || c == '2' && (next == '>' || next == '<'):
			redirect, mark, after, ok := parseRedirect(command, i)
			if !ok || mark != nil && current.heredoc {
				return nil, false
			}
			if mark != nil {
				current.heredoc = true
				pending = append(pending, *mark)
			} else {
				current.redirects = append(current.redirects, redirect)
			}
			i = after
		default:
			word, after, ok := parseWord(command, i)
			if !ok {
				return nil, false
			}
			current.words = append(current.words, word)
			joined = false
			i = after
		}
	}
	if len(pending) > 0 {
		return nil, false
	}
	if len(current.words) > 0 {
		end(false)
		joined = false
	}
	if joined || len(current.redirects) > 0 || len(steps) == 0 {
		return nil, false
	}
	return steps, true
}

// parseWord reads one word of plain bytes, single-quoted text, and
// double-quoted text without expansion or escapes.
func parseWord(command string, i int) (string, int, bool) {
	var word strings.Builder
	start := i
	for i < len(command) {
		switch c := command[i]; {
		case c == '\'':
			closing := strings.IndexByte(command[i+1:], '\'')
			if closing < 0 {
				return "", 0, false
			}
			word.WriteString(command[i+1 : i+1+closing])
			i += closing + 2
		case c == '"':
			closing := strings.IndexByte(command[i+1:], '"')
			if closing < 0 || strings.ContainsAny(command[i+1:i+1+closing], "$`\\!") {
				return "", 0, false
			}
			word.WriteString(command[i+1 : i+1+closing])
			i += closing + 2
		case shellWordByte(c):
			word.WriteByte(c)
			i++
		case c == ' ' || c == '\t' || c == '\n' || strings.IndexByte(";&|<>", c) >= 0:
			return word.String(), i, i > start
		default:
			return "", 0, false
		}
	}
	return word.String(), i, i > start
}

// parseRedirect reads one redirection: output to a file, input from a file,
// stderr to stdout, or a quoted heredoc.
func parseRedirect(command string, i int) (shellRedirect, *heredocMark, int, bool) {
	for _, op := range []string{"2>&1", "<<-", "<<", "2>>", "2>", ">>", "&>", ">", "<"} {
		if !strings.HasPrefix(command[i:], op) {
			continue
		}
		i += len(op)
		if op == "2>&1" {
			return shellRedirect{op: op}, nil, i, true
		}
		for i < len(command) && (command[i] == ' ' || command[i] == '\t') {
			i++
		}
		if op == "<<" || op == "<<-" {
			if i >= len(command) || command[i] != '\'' && command[i] != '"' {
				return shellRedirect{}, nil, 0, false
			}
			closing := strings.IndexByte(command[i+1:], command[i])
			if closing < 0 || !heredocDelimiter.MatchString(command[i+1:i+1+closing]) {
				return shellRedirect{}, nil, 0, false
			}
			mark := &heredocMark{delimiter: command[i+1 : i+1+closing], stripTabs: op == "<<-"}
			i += closing + 2
			if i < len(command) && shellWordByte(command[i]) {
				return shellRedirect{}, nil, 0, false
			}
			return shellRedirect{}, mark, i, true
		}
		if i < len(command) && strings.IndexByte("<>&|", command[i]) >= 0 {
			return shellRedirect{}, nil, 0, false
		}
		target, after, ok := parseWord(command, i)
		return shellRedirect{op: op, target: target}, nil, after, ok
	}
	return shellRedirect{}, nil, 0, false
}

// skipHeredoc returns the position after a heredoc body that starts at i.
func skipHeredoc(command string, i int, mark heredocMark) (int, bool) {
	for i < len(command) {
		line, rest, found := strings.Cut(command[i:], "\n")
		if mark.stripTabs {
			line = strings.TrimLeft(line, "\t")
		}
		next := len(command)
		if found {
			next = len(command) - len(rest)
		}
		if line == mark.delimiter {
			return next, true
		}
		i = next
	}
	return 0, false
}

// shellPaths checks the paths a command names against the workspace. places
// are the directories the command may be in at a step: a cd that fails
// leaves the earlier one, so a path must stay inside from each.
type shellPaths struct {
	workspace string
	places    []string
}

func (p *shellPaths) inside(path string) bool {
	if path == "" || slices.Contains(strings.Split(filepath.ToSlash(path), "/"), "..") {
		return false
	}
	for _, place := range p.places {
		resolved := path
		if !filepath.IsAbs(path) {
			if place == "" {
				return false
			}
			resolved = filepath.Join(place, path)
		}
		if !withinWorkspace(p.workspace, filepath.Clean(resolved)) {
			return false
		}
	}
	return true
}

// redirects reports whether every redirection reads or writes a workspace
// file or /dev/null.
func (p *shellPaths) redirects(step shellStep) bool {
	for _, redirect := range step.redirects {
		if redirect.op != "2>&1" && !(redirect.target == "/dev/null" && redirect.op != "<") && !p.inside(redirect.target) {
			return false
		}
	}
	return true
}

// cd follows a cd into the workspace.
func (p *shellPaths) cd(step shellStep) bool {
	words := step.words
	if words[0] != "cd" || len(words) != 2 || step.pipeIn || step.pipeOut || step.heredoc || len(step.redirects) > 0 || !p.inside(words[1]) {
		return false
	}
	for _, place := range p.places {
		if filepath.IsAbs(words[1]) {
			p.places = append(p.places, filepath.Clean(words[1]))
			break
		}
		p.places = append(p.places, filepath.Join(place, words[1]))
	}
	return true
}

// write reports whether a step writes only workspace files: mkdir -p, a
// heredoc written with cat or tee, or a read-only command's output.
func (p *shellPaths) write(step shellStep) bool {
	name, args := step.words[0], step.words[1:]
	if name == "cd" || !p.redirects(step) {
		return false
	}
	switch name {
	case "mkdir":
		paths := 0
		for _, arg := range args {
			switch {
			case arg == "-p":
			case strings.HasPrefix(arg, "-") || !p.inside(arg):
				return false
			default:
				paths++
			}
		}
		return paths > 0 && !step.heredoc && !step.pipeIn
	case "tee":
		paths := 0
		for _, arg := range args {
			switch {
			case arg == "-a":
			case strings.HasPrefix(arg, "-") || !p.inside(arg):
				return false
			default:
				paths++
			}
		}
		return paths > 0 && step.heredoc != step.pipeIn
	}
	if step.heredoc {
		return name == "cat" && len(args) == 0 && !step.pipeIn
	}
	return readOnlyCommand(step.words)
}

// readOnlyStep reports whether a step only reads: a read-only command whose
// output goes to the terminal, a pipe, or /dev/null.
func readOnlyStep(step shellStep) bool {
	if step.heredoc {
		return false
	}
	for _, redirect := range step.redirects {
		switch {
		case redirect.op == "2>&1":
		case redirect.op == "<":
			// Bash opens a network connection for /dev/tcp and /dev/udp.
			if strings.HasPrefix(redirect.target, "/dev/") {
				return false
			}
		case redirect.target != "/dev/null":
			return false
		}
	}
	return readOnlyCommand(step.words)
}

// readOnlyNames only read, whatever their arguments. They and the checks in
// readOnlyCommand follow Codex's known-safe commands
// (codex-rs/shell-command/src/command_safety/is_safe_command.rs before Codex
// moved them to exec policy rules), plus jq. git is left out because a
// repository's config can make even its read-only commands run helpers.
var readOnlyNames = []string{
	"cat", "cd", "cut", "echo", "expr", "false", "grep", "head", "id", "jq", "ls", "nl",
	"paste", "pwd", "rev", "seq", "stat", "tail", "tr", "true", "uname", "wc", "which", "whoami",
}

// linuxReadOnlyNames are trusted only on Linux, where they are coreutils.
var linuxReadOnlyNames = []string{"numfmt", "tac"}

var sedPrint = regexp.MustCompile(`^([0-9]+,)?[0-9]+p$`)

// readOnlyCommand reports whether a command only reads: a read-only name, or
// uniq, base64, find, rg, or sed without the options that write files or run
// other programs.
func readOnlyCommand(words []string) bool {
	name, args := words[0], words[1:]
	if slices.Contains(readOnlyNames, name) || runtime.GOOS == "linux" && slices.Contains(linuxReadOnlyNames, name) {
		return true
	}
	switch name {
	case "uniq":
		// A second operand is the file uniq writes.
		operands, options := 0, true
		for _, arg := range args {
			switch {
			case options && arg == "--":
				options = false
			case options && strings.HasPrefix(arg, "-") && arg != "-":
			default:
				operands++
			}
		}
		return operands <= 1
	case "base64":
		// -o and --output, also abbreviated or in a cluster of short options,
		// name the file it writes.
		return !slices.ContainsFunc(args, func(arg string) bool {
			return strings.HasPrefix(arg, "--o") || strings.HasPrefix(arg, "-") && !strings.HasPrefix(arg, "--") && strings.Contains(arg, "o")
		})
	case "find":
		return !slices.ContainsFunc(args, func(arg string) bool {
			return slices.Contains([]string{"-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprint0", "-fprintf"}, arg)
		})
	case "rg":
		// --pre and --hostname-bin run a program; -z runs decompressors.
		return !slices.ContainsFunc(args, func(arg string) bool {
			return arg == "--search-zip" || strings.HasPrefix(arg, "-") && !strings.HasPrefix(arg, "--") && strings.Contains(arg, "z") ||
				slices.ContainsFunc([]string{"--pre", "--hostname-bin"}, func(option string) bool { return arg == option || strings.HasPrefix(arg, option+"=") })
		})
	case "sed":
		return len(words) >= 3 && len(words) <= 4 && words[1] == "-n" && sedPrint.MatchString(words[2])
	}
	return false
}

// withinWorkspace reports whether an absolute path stays in the workspace,
// following the links of the part of it that already exists.
func withinWorkspace(workspace, path string) bool {
	if workspace == "" || !filepath.IsAbs(workspace) || !filepath.IsAbs(path) {
		return false
	}
	root, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return false
	}
	existing, rest := path, ""
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return false
		}
		rest = filepath.Join(filepath.Base(existing), rest)
		existing = parent
	}
	resolved, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return false
	}
	return lexicallyWithin(root, filepath.Join(resolved, rest))
}

func lexicallyWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
