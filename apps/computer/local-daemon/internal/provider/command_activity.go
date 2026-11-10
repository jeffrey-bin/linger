package provider

import (
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// scriptSteps names the steps of a shell script for the Room status line,
// the same for every Runtime's shell tool: each command of its lists, a
// pipeline by its first stage, without navigation, output shaping, or the
// commands that only supply an argument. Unrecognized commands are left out.
func scriptSteps(script string) []step {
	commands := simpleCommands(script)
	if waitsForReplies(commands) {
		return []step{{kind: native.ActivityMessageRead, text: "Waiting for replies"}}
	}
	var steps []step
	for _, command := range commands {
		teamhub := filepath.Base(command.words[0]) == "teamhub"
		if command.nested || command.filter && !teamhub {
			continue
		}
		if next, ok := commandStep(command); ok {
			steps = appendStep(steps, next)
		}
	}
	return steps
}

// waitsForReplies is reading messages after a sleep, as Agents poll for the
// replies of the members they asked.
func waitsForReplies(commands []shellCommand) bool {
	slept := slices.ContainsFunc(commands, func(command shellCommand) bool {
		return filepath.Base(command.words[0]) == "sleep"
	})
	return slept && slices.ContainsFunc(commands, func(command shellCommand) bool {
		if filepath.Base(command.words[0]) != "teamhub" {
			return false
		}
		path := teamhubPath(command.words[1:])
		return len(path) > 1 && path[0] == "message" && !messageSends[path[1]]
	})
}

// scaffolding commands move around, print, or shape output; they are never
// what a script is for.
var scaffolding = map[string]bool{
	"cd": true, "pushd": true, "popd": true, "echo": true, "printf": true, "export": true, "unset": true,
	"set": true, "source": true, ".": true, "true": true, "false": true, ":": true, "which": true,
	"command": true, "type": true, "hash": true, "wc": true, "sort": true, "uniq": true, "cut": true,
	"tr": true, "xargs": true, "pwd": true, "printenv": true, "test": true, "[": true,
	"[[": true, "local": true, "declare": true, "return": true, "exit": true, "mkdir": true, "sleep": true,
	"read": true, "shift": true, "trap": true, "wait": true, "clear": true, "basename": true,
	"dirname": true, "realpath": true, "readlink": true, "seq": true, "yes": true, "tee": true,
	"whoami": true, "done": true, "fi": true, "esac": true, "}": true,
	// Loop and function headers.
	"for": true, "select": true, "case": true, "function": true,
}

// wrappers run the command after their own options and assignments.
var wrappers = map[string]bool{"sudo": true, "nice": true, "timeout": true, "stdbuf": true, "caffeinate": true, "env": true}

// commandPhrases are the programs a fixed phrase describes.
var commandPhrases = func() map[string]step {
	phrases := map[string]step{}
	for _, group := range []struct {
		step     step
		programs []string
	}{
		{step{kind: native.ActivityCommand, text: "Running a script"}, []string{"python", "python3", "node", "deno", "ruby", "perl", "php", "Rscript", "tsx", "ts-node"}},
		{step{kind: native.ActivityCommand, text: "Running tests"}, []string{"pytest", "vitest", "jest", "mocha", "playwright", "phpunit"}},
		{step{kind: native.ActivityCommand, text: "Checking code"}, []string{"tsc", "eslint", "prettier", "ruff", "black", "mypy", "pyright", "gofmt", "golangci-lint", "shellcheck"}},
		{step{kind: native.ActivityCommand, text: "Installing dependencies"}, []string{"pip", "pip3", "brew", "apt", "apt-get", "conda"}},
		{step{kind: native.ActivityCommand, text: "Managing containers"}, []string{"docker", "docker-compose", "podman", "kubectl", "helm"}},
		{step{kind: native.ActivityCommand, text: "Querying a database"}, []string{"psql", "mysql", "sqlite3", "redis-cli", "mongosh", "duckdb"}},
		{step{kind: native.ActivityCommand, text: "Working on a server"}, []string{"ssh"}},
		{step{kind: native.ActivityCommand, text: "Copying files"}, []string{"scp", "rsync"}},
		{step{kind: native.ActivityFileChange, text: "Organizing files"}, []string{"cp", "mv", "rm", "rmdir", "ln", "touch", "chmod", "chown"}},
		{step{kind: native.ActivityCommand, text: "Converting files"}, []string{"pandoc", "soffice", "libreoffice", "iconv", "pdftotext", "textutil", "markitdown"}},
		{step{kind: native.ActivityCommand, text: "Processing media"}, []string{"ffmpeg", "ffprobe", "convert", "magick", "sips", "exiftool"}},
		{step{kind: native.ActivityCommand, text: "Processing data"}, []string{"jq", "yq", "awk", "gawk"}},
		{step{kind: native.ActivityCommand, text: "Archiving files"}, []string{"tar", "zip", "gzip", "7z"}},
		{step{kind: native.ActivityCommand, text: "Unpacking files"}, []string{"unzip", "gunzip"}},
		{step{kind: native.ActivityCommand, text: "Using Lark"}, []string{"lark-cli"}},
		{step{kind: native.ActivityCommand, text: "Using GitHub"}, []string{"gh"}},
		{step{kind: native.ActivityCommand, text: "Using GitLab"}, []string{"glab"}},
		{step{kind: native.ActivityCommand, text: "Using AWS"}, []string{"aws"}},
		{step{kind: native.ActivityCommand, text: "Using Google Cloud"}, []string{"gcloud"}},
		{step{kind: native.ActivityCommand, text: "Checking the time"}, []string{"date", "cal"}},
		{step{kind: native.ActivityCommand, text: "Opening a file"}, []string{"open", "xdg-open"}},
		{step{kind: native.ActivitySearch, text: "Searching the web"}, []string{"lev8"}},
	} {
		for _, program := range group.programs {
			phrases[program] = group.step
		}
	}
	return phrases
}()

// commandStep names one simple command by its program, falling back on
// what its arguments look like.
func commandStep(command shellCommand) (step, bool) {
	words := command.words
	for len(words) > 1 && wrappers[filepath.Base(words[0])] {
		words = words[1:]
		for len(words) > 1 && (strings.HasPrefix(words[0], "-") || numeric(words[0]) || assignment.MatchString(words[0])) {
			words = words[1:]
		}
	}
	program, args := filepath.Base(words[0]), words[1:]
	if program == "teamhub" {
		return teamhubStep(args), true
	}
	switch program {
	case "cat", "echo", "printf", "tee":
		// Output redirected into files writes them.
		written := slices.DeleteFunc(slices.Clone(command.writes), func(path string) bool { return strings.HasPrefix(path, "/dev/") })
		if program == "tee" {
			written = append(written, operands(args)...)
		}
		if len(written) > 0 {
			return writeStep(written), true
		}
	}
	if scaffolding[program] {
		return step{}, false
	}
	if phrase, ok := commandPhrases[program]; ok {
		return phrase, true
	}
	switch program {
	case "cat", "head", "tail", "less", "more", "bat", "nl":
		if files := operands(args); len(files) > 0 {
			return readStep(files), true
		}
		return step{}, false
	case "rg", "grep", "egrep", "fgrep", "ag", "ack":
		return searchStep(searchPattern(args)), true
	case "ls", "find", "tree", "fd", "du":
		folders := operands(args)
		if program == "find" && len(folders) > 1 {
			folders = folders[:1]
		}
		return listStep(folders), true
	case "curl", "wget", "http", "xh":
		return fetchStep(args...), true
	case "sed", "perl":
		if slices.ContainsFunc(args, func(arg string) bool { return strings.HasPrefix(arg, "-i") || strings.HasPrefix(arg, "-pi") }) {
			// The first operand is the expression.
			files := operands(args)
			return editStep(files[min(1, len(files)):]), true
		}
		if program == "sed" {
			return step{kind: native.ActivityCommand, text: "Processing data"}, true
		}
		return step{kind: native.ActivityCommand, text: "Running a script"}, true
	case "bash", "sh", "zsh":
		if len(operands(args)) > 0 {
			return step{kind: native.ActivityCommand, text: "Running a script"}, true
		}
		return step{}, false
	case "git":
		return gitStep(args), true
	case "npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx", "uv", "poetry", "go", "cargo", "make", "just":
		return toolchainStep(program, args), true
	}
	// An unknown program is described by what it is given.
	if sites := fetchStep(args...); len(sites.objects) > 0 {
		return sites, true
	}
	if strings.ContainsRune(words[0], '/') || strings.HasSuffix(program, ".sh") || strings.HasSuffix(program, ".py") {
		return step{kind: native.ActivityCommand, text: "Running a script"}, true
	}
	return step{}, false
}

var gitPhrases = map[string]string{
	"status": "Checking changes", "diff": "Checking changes", "show": "Checking changes", "log": "Checking history",
	"blame": "Checking history", "add": "Committing changes", "commit": "Committing changes", "push": "Pushing changes",
	"pull": "Pulling changes", "fetch": "Pulling changes", "clone": "Cloning a repository", "checkout": "Switching branches",
	"switch": "Switching branches", "branch": "Checking branches", "merge": "Merging changes", "rebase": "Rebasing changes",
	"stash": "Stashing changes",
}

func gitStep(args []string) step {
	for index := 0; index < len(args); index++ {
		if args[index] == "-C" || args[index] == "-c" {
			index++
			continue
		}
		if phrase, ok := gitPhrases[args[index]]; ok {
			return step{kind: native.ActivityCommand, text: phrase}
		}
		if !strings.HasPrefix(args[index], "-") {
			break
		}
	}
	return step{kind: native.ActivityCommand, text: "Using git"}
}

// toolchainStep names a package manager or build tool run by what it does.
func toolchainStep(program string, args []string) step {
	purpose := func(words []string) string {
		for _, word := range words {
			word = strings.ToLower(word)
			switch {
			case strings.Contains(word, "test") || strings.Contains(word, "vitest") || strings.Contains(word, "jest") || strings.Contains(word, "playwright") || word == "e2e":
				return "Running tests"
			case word == "install" || word == "i" || word == "add" || word == "ci" || word == "sync" || word == "get" || word == "mod" || word == "remove" || word == "uninstall":
				return "Installing dependencies"
			case strings.Contains(word, "build"):
				return "Building the project"
			case strings.Contains(word, "lint") || strings.Contains(word, "typecheck") || strings.Contains(word, "check") || strings.Contains(word, "vet") || strings.Contains(word, "fmt") || strings.Contains(word, "format") || strings.Contains(word, "clippy") || word == "tsc" || word == "eslint":
				return "Checking code"
			case word == "dev" || word == "start" || word == "serve" || word == "preview":
				return "Starting the app"
			}
		}
		return ""
	}
	if phrase := purpose(operands(args)); phrase != "" {
		return step{kind: native.ActivityCommand, text: phrase}
	}
	if program == "make" || program == "just" {
		return step{kind: native.ActivityCommand, text: "Building the project"}
	}
	return step{kind: native.ActivityCommand, text: "Running a script"}
}

// searchPattern is what grep-like programs search for: the first operand,
// or the value of -e.
func searchPattern(args []string) string {
	valued := map[string]bool{"-g": true, "--glob": true, "-t": true, "--type": true, "-T": true, "--type-not": true, "-m": true, "--max-count": true, "-A": true, "-B": true, "-C": true, "--context": true, "-f": true, "--file": true, "-M": true, "--max-columns": true}
	for index := 0; index < len(args); index++ {
		switch arg := args[index]; {
		case arg == "-e" || arg == "--regexp":
			if index+1 < len(args) {
				return args[index+1]
			}
		case valued[arg]:
			index++
		case !strings.HasPrefix(arg, "-"):
			return arg
		}
	}
	return ""
}

// operands are the arguments that are neither options nor counts.
func operands(args []string) []string {
	var found []string
	for _, arg := range args {
		if arg != "" && !strings.HasPrefix(arg, "-") && !numeric(arg) {
			found = append(found, arg)
		}
	}
	return found
}

var number = regexp.MustCompile(`^[+-]?[0-9][0-9.]*[a-zA-Z]?$`)

func numeric(word string) bool { return number.MatchString(word) }

// commandWord is a TeamHub CLI command or subcommand name.
var commandWord = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// messageSends post to the Room, which shows the message itself.
var messageSends = map[string]bool{"send": true, "direct": true, "emoji": true, "sequence": true}

// teamhubPath is the leading command words of a TeamHub CLI call, at most
// three, so an operand may follow the command.
func teamhubPath(args []string) []string {
	var path []string
	for _, arg := range args {
		if len(path) == 3 || !commandWord.MatchString(arg) {
			break
		}
		path = append(path, arg)
	}
	return path
}

// teamhubPhrases name TeamHub CLI commands; the longest matching prefix of a
// call's command words wins.
var teamhubPhrases = map[string]string{
	"message read":             "Reading messages",
	"message search":           "Searching messages",
	"docs list":                "Looking through documents",
	"docs get":                 "Reading a document",
	"docs create":              "Creating a document",
	"docs update":              "Editing a document",
	"docs replace":             "Editing a document",
	"docs request":             "Requesting document access",
	"docs comment get":         "Reading comments",
	"docs comment reply":       "Replying to a comment",
	"docs comment replace":     "Editing a comment",
	"docs image put":           "Adding an image to a document",
	"docs image get":           "Viewing a document image",
	"agent list":               "Checking agents",
	"agent get":                "Checking an agent",
	"agent create":             "Creating an agent",
	"agent update":             "Updating an agent",
	"apps list":                "Checking connected apps",
	"apps search":              "Searching apps",
	"apps connect":             "Connecting an app",
	"apps execute":             "Using a connected app",
	"apps auto-reminders list": "Checking reminders",
	"apps auto-reminders set":  "Setting reminders",
	"knowledge search":         "Searching knowledge",
	"knowledge read":           "Reading knowledge",
	"tracking-items list":      "Checking tracking items",
	"tracking-items add":       "Adding a tracking item",
	"tracking-items update":    "Updating a tracking item",
	"tracking-items done":      "Closing a tracking item",
	"profile skill publish":    "Publishing a skill",
	"room create":              "Creating a room",
	"room collaborate":         "Writing the room protocol",
	"room invite":              "Inviting an agent",
	"room members":             "Checking room members",
	"room protocol":            "Reading the room protocol",
	"task list":                "Checking tasks",
	"task members":             "Checking task members",
	"task create":              "Assigning a task",
	"task finish":              "Finishing a task",
	"routine create":           "Scheduling a routine",
	"routine list":             "Checking routines",
	"routine pause":            "Pausing a routine",
	"routine enable":           "Resuming a routine",
	"routine run":              "Running a routine",
	"routine delete":           "Deleting a routine",
}

// connectorApps are the Connectors the TeamHub CLI exposes as commands.
var connectorApps = map[string]string{
	"figma": "Figma", "gcal": "Calendar", "gdrive": "Google Drive", "github": "GitHub", "gmail": "Gmail",
	"notion": "Notion", "outlook": "Outlook", "slack": "Slack",
}

// mediaCommands are the TeamHub CLI's generation commands and what they make.
var mediaCommands = map[string]struct{ noun, one string }{
	"image-gen": {"image", "an image"},
	"video-gen": {"video", "a video"},
}

var connectorWrites = map[string]bool{
	"append": true, "archive": true, "cancel": true, "create": true, "create-issue": true, "edit": true, "mkdir": true,
	"update": true, "upload": true,
}

// teamhubStep names a TeamHub CLI call. Sending a message is quiet: the
// Room shows the message.
func teamhubStep(args []string) step {
	path := teamhubPath(args)
	if len(path) == 0 || slices.ContainsFunc(args, isHelpFlag) {
		return step{kind: native.ActivityTool, text: "Checking TeamHub commands"}
	}
	is := func(words ...string) bool {
		return len(path) >= len(words) && slices.Equal(path[:len(words)], words)
	}
	kind := native.ActivityTool
	switch {
	case len(path) > 1 && path[0] == "message" && messageSends[path[1]]:
		return step{kind: native.ActivityMessage, quiet: true}
	case path[0] == "message":
		kind = native.ActivityMessageRead
	case slices.Contains(path, "search"):
		kind = native.ActivitySearch
	case is("knowledge", "wiki", "read"), is("knowledge", "raw", "read"), is("docs", "get"), is("docs", "comment", "get"), is("docs", "image", "get"):
		kind = native.ActivityRead
	case is("docs", "create"), is("docs", "update"), is("docs", "replace"), is("docs", "comment", "reply"), is("docs", "comment", "replace"), is("docs", "image", "put"):
		kind = native.ActivityFileChange
	case is("task", "create"):
		kind = native.ActivityDelegation
	}
	// An Agent's name is the one object kept, as grok-bot does.
	if name := strings.TrimSpace(flagValue(args, "--name")); name != "" && (is("agent", "create") || is("agent", "update")) {
		verb := "Creating"
		if path[1] == "update" {
			verb = "Updating"
		}
		return step{kind: kind, text: verb + " " + clip(name, 48)}
	}
	// A generation command starts a job, checks one, or reads model prices,
	// depending on its flags.
	if media, ok := mediaCommands[path[0]]; ok {
		switch {
		case slices.Contains(args, "--price"):
			return step{kind: kind, text: "Checking " + media.noun + " models"}
		case flagValue(args, "--job") != "":
			return step{kind: kind, text: "Checking on the " + media.noun}
		}
		return step{kind: kind, text: "Generating " + media.one}
	}
	for length := len(path); length > 0; length-- {
		if phrase, ok := teamhubPhrases[strings.Join(path[:length], " ")]; ok {
			return step{kind: kind, text: phrase}
		}
	}
	app, ok := connectorApps[path[0]]
	if !ok {
		return step{kind: kind, text: "Using TeamHub"}
	}
	verbs := path[1:]
	text := "Checking " + app
	switch {
	case slices.Contains(verbs, "search"):
		text = "Searching " + app
	case slices.ContainsFunc(verbs, func(verb string) bool {
		return verb == "send" || verb == "reply" || verb == "comment" || verb == "react"
	}):
		text = "Posting in " + app
	case slices.ContainsFunc(verbs, func(verb string) bool { return strings.HasSuffix(verb, "draft") }):
		text = "Drafting in " + app
	case slices.ContainsFunc(verbs, func(verb string) bool { return connectorWrites[verb] }):
		text = "Updating " + app
	}
	return step{kind: kind, text: text}
}

// shellCommand is one simple command of a script, for display only.
type shellCommand struct {
	words []string
	// writes are the files its output is redirected into.
	writes []string
	// filter marks a later stage of a pipeline, which shapes the output of
	// the stage before it.
	filter bool
	// nested marks a command inside a command substitution, which supplies
	// an argument to another command.
	nested bool
}

var (
	shellKeywords   = map[string]bool{"do": true, "then": true, "else": true, "elif": true, "if": true, "while": true, "until": true, "!": true, "{": true, "time": true, "exec": true, "nohup": true}
	assignment      = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	heredocOperator = regexp.MustCompile(`^<<-?[ \t]*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?`)
)

// simpleCommands splits a script into its simple commands, for display
// only. Lists, pipelines, subshells and substitutions separate commands;
// heredoc bodies, leading keywords such as `do`, and variable assignments are
// dropped, and redirections are kept apart from the words. An unclosed quote
// runs to the end.
func simpleCommands(script string) []shellCommand {
	var commands []shellCommand
	var current shellCommand
	var heredocs []string
	// groups holds the open parentheses; true marks a command substitution.
	var groups []bool
	var word strings.Builder
	inWord, dropWord, writeWord, backtick := false, false, false, false
	nested := func() bool { return backtick || slices.Contains(groups, true) }
	endWord := func() {
		if inWord && !dropWord {
			current.words = append(current.words, word.String())
		}
		if inWord && dropWord && writeWord {
			current.writes = append(current.writes, word.String())
		}
		if inWord {
			dropWord, writeWord = false, false
		}
		word.Reset()
		inWord = false
	}
	endCommand := func() {
		endWord()
		for len(current.words) > 0 && (shellKeywords[current.words[0]] || assignment.MatchString(current.words[0])) {
			current.words = current.words[1:]
		}
		if len(current.words) > 0 {
			commands = append(commands, current)
		}
		current = shellCommand{nested: nested()}
	}
	for index := 0; index < len(script); index++ {
		char := script[index]
		switch {
		case char == ' ' || char == '\t':
			endWord()
		case char == '\n':
			endCommand()
			for _, delimiter := range heredocs {
				for index < len(script) {
					start := index + 1
					end := strings.IndexByte(script[start:], '\n')
					if end < 0 {
						end = len(script)
					} else {
						end += start
					}
					line := script[start:end]
					index = end
					if strings.TrimSpace(line) == delimiter {
						break
					}
				}
			}
			heredocs = nil
		case char == '\'':
			closing := strings.IndexByte(script[index+1:], '\'')
			if closing < 0 {
				closing = len(script) - index - 1
			}
			word.WriteString(script[index+1 : index+1+closing])
			inWord, index = true, index+1+closing
		case char == '"':
			index++
			for ; index < len(script) && script[index] != '"'; index++ {
				if script[index] == '\\' && index+1 < len(script) {
					index++
				}
				word.WriteByte(script[index])
			}
			inWord = true
		case char == '\\' && index+1 < len(script):
			index++
			if script[index] != '\n' {
				word.WriteByte(script[index])
				inWord = true
			}
		case strings.HasPrefix(script[index:], "<<") && !strings.HasPrefix(script[index:], "<<<"):
			endWord()
			if match := heredocOperator.FindStringSubmatch(script[index:]); match != nil {
				heredocs = append(heredocs, match[1])
				index += len(match[0]) - 1
			} else {
				index++
			}
		case char == '<' || char == '>':
			// A redirection: drop the file descriptor before it and its
			// target, keeping the target of an output redirection.
			if inWord && strings.Trim(word.String(), "0123456789") == "" {
				word.Reset()
				inWord = false
			}
			endWord()
			output := char == '>'
			for index+1 < len(script) && strings.IndexByte("<>&", script[index+1]) >= 0 {
				index++
				output = output || script[index] == '>'
			}
			if script[index] == '&' && index+1 < len(script) && (script[index+1] == '-' || script[index+1] >= '0' && script[index+1] <= '9') {
				index++
			} else {
				dropWord, writeWord = true, output
			}
		case char == '|':
			endCommand()
			// A single bar pipes into the next command; || is a list.
			current.filter = (index+1 >= len(script) || script[index+1] != '|') && (index == 0 || script[index-1] != '|')
		case char == '&' && index > 0 && script[index-1] == '|':
			// |& pipes standard error too.
		case char == ';' || char == '&':
			endCommand()
		case strings.HasPrefix(script[index:], "$("):
			endCommand()
			groups = append(groups, true)
			current.nested = true
			index++
		case char == '(':
			endCommand()
			groups = append(groups, false)
		case char == ')':
			endCommand()
			if len(groups) > 0 {
				groups = groups[:len(groups)-1]
			}
			current.nested = nested()
		case char == '`':
			endCommand()
			backtick = !backtick
			current.nested = nested()
		default:
			word.WriteByte(char)
			inWord = true
		}
	}
	endCommand()
	return commands
}

// shellScript returns the script of `bash -lc '…'`, or the command itself.
func shellScript(command string) string {
	words, ok := splitCommand(strings.TrimSpace(command))
	if ok && len(words) == 3 && slices.Contains([]string{"bash", "sh", "zsh"}, filepath.Base(words[0])) && (words[1] == "-c" || words[1] == "-lc") {
		return words[2]
	}
	return command
}

// splitCommand splits one shell command into words for display only. It
// honors quotes and allows a trailing heredoc body; it rejects lists,
// pipelines, redirections, and substitutions outside quotes.
func splitCommand(command string) ([]string, bool) {
	var words []string
	var word strings.Builder
	inWord := false
	end := func() {
		if inWord {
			words = append(words, word.String())
			word.Reset()
			inWord = false
		}
	}
	for index := 0; index < len(command); index++ {
		char := command[index]
		switch {
		case char == ' ' || char == '\t':
			end()
		case char == '\n':
			// A newline ends the command; only a heredoc body may follow.
			end()
			return words, strings.TrimSpace(command[index:]) == ""
		case char == '\'':
			closing := strings.IndexByte(command[index+1:], '\'')
			if closing < 0 {
				return nil, false
			}
			word.WriteString(command[index+1 : index+1+closing])
			inWord, index = true, index+1+closing
		case char == '"':
			index++
			for ; index < len(command) && command[index] != '"'; index++ {
				if command[index] == '\\' && index+1 < len(command) {
					index++
				}
				word.WriteByte(command[index])
			}
			if index == len(command) {
				return nil, false
			}
			inWord = true
		case char == '\\' && index+1 < len(command):
			index++
			word.WriteByte(command[index])
			inWord = true
		case strings.HasPrefix(command[index:], "<<"):
			end()
			return words, true
		case strings.IndexByte(";|&<>`()", char) >= 0, strings.HasPrefix(command[index:], "$("):
			return nil, false
		default:
			word.WriteByte(char)
			inWord = true
		}
	}
	end()
	return words, true
}

func isHelpFlag(word string) bool {
	return word == "--help" || word == "-h" || word == "--schema"
}

func flagValue(words []string, flag string) string {
	for index, word := range words {
		if value, ok := strings.CutPrefix(word, flag+"="); ok {
			return value
		}
		if word == flag && index+1 < len(words) {
			return words[index+1]
		}
	}
	return ""
}
