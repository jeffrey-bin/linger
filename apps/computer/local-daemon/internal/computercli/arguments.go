package computercli

import (
	"fmt"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

var runtimeTypes = []string{"codex", "claude", "pi"}

// command is one parsed command line.
type command struct {
	name       string
	configPath string
	topic      string
	json       bool

	// daemon stop
	ifIdle bool
	// doctor
	prune bool
	// runtime check
	live    bool
	runtime string
	// doctor, runtime check and login; nil when no override was given.
	runtimePaths map[string]string
	// daemon logs
	follow bool
	lines  int
	// daemon runners inspect|stop
	agentID string

	// login
	webURL          string
	displayName     string
	gatewayURL      string
	codexAuthFile   string
	maxRunsSet      bool
	maxRuns         *int
	enabledRuntimes []string
	tokenStdin      bool

	// daemon service start|stop
	serviceName string
	executable  string
	serviceArgs []string
	cwd         string
}

type parseOptions struct {
	goos             string
	environment      map[string]string
	homeDirectory    string
	hostName         string
	workingDirectory string
	commandName      string
}

var groups = map[string]bool{"auth": true, "daemon": true, "runtime": true}

func isHelpFlag(value string) bool { return value == "help" || value == "--help" || value == "-h" }

func parseArguments(rawArgs []string, options parseOptions) (command, error) {
	args := slices.Clone(rawArgs)
	if err := rejectSecretInArguments(args, options.commandName); err != nil {
		return command{}, err
	}
	var passthrough []string
	if separator := slices.Index(args, "--"); separator != -1 {
		passthrough = slices.Clone(args[separator+1:])
		args = args[:separator]
	}
	explicitConfig, err := removeOption(&args, "--config")
	if err != nil {
		return command{}, err
	}
	configPath := resolveConfigPath(explicitConfig, options)
	unknown := func() error { return unknownCommand(rawArgs, options.commandName) }
	if len(args) == 0 || isHelpFlag(args[0]) {
		if len(args) > 0 {
			args = args[1:]
		}
		topic := strings.Join(args, " ")
		if _, ok := commandHelp[topic]; topic != "" && !ok {
			return command{}, unknown()
		}
		return command{name: "help", configPath: configPath, topic: topic}, nil
	}
	group := args[0]
	args = args[1:]
	name := group
	if groups[group] {
		if len(args) == 0 || isHelpFlag(args[0]) {
			if len(args) > 1 {
				return command{}, unknown()
			}
			return command{name: "help", configPath: configPath, topic: group}, nil
		}
		name = group + " " + args[0]
		args = args[1:]
	}
	longHelp, err := removeFlag(&args, "--help")
	if err != nil {
		return command{}, err
	}
	shortHelp, err := removeFlag(&args, "-h")
	if err != nil {
		return command{}, err
	}
	if longHelp || shortHelp {
		if _, ok := commandHelp[name]; !ok {
			return command{}, unknown()
		}
		return command{name: "help", configPath: configPath, topic: name}, nil
	}
	parsed := command{configPath: configPath}
	requireEmpty := func() error {
		if len(args) > 0 {
			return unknown()
		}
		return nil
	}
	switch name {
	case "login":
		return parseLogin(args, configPath, options)
	case "auth status":
		if parsed.json, err = removeFlag(&args, "--json"); err != nil {
			return command{}, err
		}
		parsed.name = "auth-status"
		return parsed, requireEmpty()
	case "daemon stop":
		if parsed.ifIdle, err = removeFlag(&args, "--if-idle"); err != nil {
			return command{}, err
		}
		parsed.name = "daemon-stop"
		return parsed, requireEmpty()
	case "daemon start", "daemon restart":
		parsed.name = strings.ReplaceAll(name, " ", "-")
		return parsed, requireEmpty()
	case "version":
		parsed.name = "version"
		return parsed, requireEmpty()
	case "daemon status":
		if parsed.json, err = removeFlag(&args, "--json"); err != nil {
			return command{}, err
		}
		parsed.name = "daemon-status"
		return parsed, requireEmpty()
	case "doctor":
		if parsed.json, err = removeFlag(&args, "--json"); err != nil {
			return command{}, err
		}
		if parsed.prune, err = removeFlag(&args, "--prune"); err != nil {
			return command{}, err
		}
		if parsed.runtimePaths, err = removeRuntimePaths(&args, options); err != nil {
			return command{}, err
		}
		parsed.name = "doctor"
		return parsed, requireEmpty()
	case "runtime check":
		if parsed.json, err = removeFlag(&args, "--json"); err != nil {
			return command{}, err
		}
		if parsed.live, err = removeFlag(&args, "--live"); err != nil {
			return command{}, err
		}
		if parsed.runtimePaths, err = removeRuntimePaths(&args, options); err != nil {
			return command{}, err
		}
		if len(args) > 0 {
			runtimeName := args[0]
			args = args[1:]
			if err := requireEmpty(); err != nil {
				return command{}, err
			}
			runtime, ok := runtimeAliases[runtimeName]
			if !ok {
				return command{}, newError(categoryUsage, fmt.Sprintf("Unknown runtime: %s. Use codex, claude, or pi.", runtimeName))
			}
			parsed.runtime = runtime
		}
		parsed.name = "runtime-check"
		return parsed, nil
	case "daemon logs":
		follow, err := removeFlag(&args, "-f")
		if err != nil {
			return command{}, err
		}
		longFollow, err := removeFlag(&args, "--follow")
		if err != nil {
			return command{}, err
		}
		value, err := removeOption(&args, "-n")
		if err != nil {
			return command{}, err
		}
		if value == "" {
			value = "200"
		}
		lines, err := strconv.Atoi(value)
		if err != nil || lines < 1 || lines > 10_000 {
			return command{}, newError(categoryUsage, "Log line count must be between 1 and 10000")
		}
		parsed.name, parsed.follow, parsed.lines = "daemon-logs", follow || longFollow, lines
		return parsed, requireEmpty()
	case "daemon runners":
		if parsed.json, err = removeFlag(&args, "--json"); err != nil {
			return command{}, err
		}
		if len(args) == 0 {
			parsed.name = "daemon-runners"
			return parsed, nil
		}
		if len(args) == 2 && (args[0] == "inspect" || args[0] == "stop") {
			if strings.TrimSpace(args[1]) == "" {
				return command{}, newError(categoryUsage, "Agent id must not be empty")
			}
			parsed.name, parsed.agentID = "runner-"+args[0], args[1]
			return parsed, nil
		}
	case "daemon service":
		action := ""
		if len(args) > 0 {
			action, args = args[0], args[1:]
		}
		switch action {
		case "list":
			if parsed.json, err = removeFlag(&args, "--json"); err != nil {
				return command{}, err
			}
			if len(args) > 0 || len(passthrough) > 0 {
				return command{}, unknown()
			}
			parsed.name = "service-list"
			return parsed, nil
		case "stop":
			if len(args) != 1 || len(passthrough) > 0 {
				return command{}, unknown()
			}
			parsed.name, parsed.serviceName = "service-stop", args[0]
			return parsed, nil
		case "start":
			if len(args) != 1 || len(passthrough) == 0 || passthrough[0] == "" {
				return command{}, unknown()
			}
			parsed.name, parsed.serviceName = "service-start", args[0]
			parsed.executable, parsed.serviceArgs = passthrough[0], passthrough[1:]
			parsed.cwd = options.workingDirectory
			return parsed, nil
		}
	}
	return command{}, unknown()
}

var runtimeAliases = map[string]string{"codex": "codex", "claude": "claude", "claude-code": "claude", "pi": "pi"}

func parseLogin(args []string, configPath string, options parseOptions) (command, error) {
	parsed := command{name: "login", configPath: configPath}
	var err error
	if parsed.webURL, err = removeOption(&args, "--web-url"); err != nil {
		return command{}, err
	}
	if parsed.webURL == "" {
		parsed.webURL = options.environment["LINGER_WEB_URL"]
	}
	if parsed.webURL == "" {
		parsed.webURL = "http://localhost:3000"
	}
	if parsed.displayName, err = removeOption(&args, "--name"); err != nil {
		return command{}, err
	}
	if parsed.displayName == "" {
		parsed.displayName = options.hostName
	}
	if parsed.gatewayURL, err = removeOption(&args, "--gateway-url"); err != nil {
		return command{}, err
	}
	maximum, err := removeOption(&args, "--max-concurrent-runs")
	if err != nil {
		return command{}, err
	}
	clearMaximum, err := removeFlag(&args, "--no-max-concurrent-runs")
	if err != nil {
		return command{}, err
	}
	if maximum != "" && clearMaximum {
		return command{}, newError(categoryUsage, "Use only one of --max-concurrent-runs or --no-max-concurrent-runs")
	}
	if clearMaximum {
		parsed.maxRunsSet = true
	} else if maximum != "" {
		value, err := strconv.Atoi(maximum)
		if err != nil || value < 1 || value > 100 {
			return command{}, newError(categoryUsage, "--max-concurrent-runs must be an integer between 1 and 100")
		}
		parsed.maxRunsSet, parsed.maxRuns = true, &value
	}
	codexAuth, err := removeOption(&args, "--codex-auth")
	if err != nil {
		return command{}, err
	}
	if codexAuth != "" {
		parsed.codexAuthFile = resolvePath(options.workingDirectory, codexAuth)
	}
	if parsed.tokenStdin, err = removeFlag(&args, "--token-stdin"); err != nil {
		return command{}, err
	}
	paths, err := removeRuntimePaths(&args, options)
	if err != nil {
		return command{}, err
	}
	parsed.runtimePaths = paths
	if parsed.runtimePaths == nil {
		parsed.runtimePaths = map[string]string{}
	}
	if parsed.enabledRuntimes, err = removeEnabledRuntimes(&args); err != nil {
		return command{}, err
	}
	if len(args) > 0 {
		return command{}, unknownCommand(append([]string{"login"}, args...), options.commandName)
	}
	return parsed, nil
}

func removeRuntimePaths(args *[]string, options parseOptions) (map[string]string, error) {
	var values map[string]string
	for _, runtimeType := range runtimeTypes {
		value, err := removeOption(args, "--"+runtimeType+"-path")
		if err != nil {
			return nil, err
		}
		if value != "" {
			if values == nil {
				values = map[string]string{}
			}
			values[runtimeType] = resolvePath(options.workingDirectory, value)
		}
	}
	return values, nil
}

func removeEnabledRuntimes(args *[]string) ([]string, error) {
	var types []string
	for index := slices.Index(*args, "--enabled-runtime"); index != -1; index = slices.Index(*args, "--enabled-runtime") {
		if index+1 >= len(*args) || (*args)[index+1] == "" || strings.HasPrefix((*args)[index+1], "--") {
			return nil, newError(categoryUsage, "--enabled-runtime requires a Runtime type")
		}
		types = append(types, (*args)[index+1])
		*args = slices.Delete(*args, index, index+2)
	}
	if types == nil {
		return nil, nil
	}
	if !validRuntimeSelection(types) {
		return nil, newError(categoryUsage, "--enabled-runtime requires unique codex, claude or pi values")
	}
	return types, nil
}

func validRuntimeSelection(types []string) bool {
	seen := map[string]bool{}
	for _, runtimeType := range types {
		if !slices.Contains(runtimeTypes, runtimeType) || seen[runtimeType] {
			return false
		}
		seen[runtimeType] = true
	}
	return len(types) > 0
}

func resolveConfigPath(explicit string, options parseOptions) string {
	value := explicit
	if value == "" {
		value = options.environment["LINGER_COMPUTER_CONFIG"]
	}
	if value == "" {
		if dataDirectory := strings.TrimSpace(options.environment["LINGER_COMPUTER_DATA_DIR"]); dataDirectory != "" {
			value = filepath.Join(dataDirectory, "config.json")
		} else {
			value = filepath.Join(defaultDataRoot(options), "config.json")
		}
	}
	return resolvePath(options.workingDirectory, value)
}

func defaultDataRoot(options parseOptions) string {
	if options.goos == "windows" {
		local := options.environment["LOCALAPPDATA"]
		if local == "" {
			local = filepath.Join(options.homeDirectory, "AppData", "Local")
		}
		return filepath.Join(local, "Linger", "Computer")
	}
	return filepath.Join(options.homeDirectory, ".local", "share", "linger", "computer")
}

func resolvePath(workingDirectory, value string) string {
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	return filepath.Join(workingDirectory, value)
}

func rejectSecretInArguments(args []string, _ string) error {
	for _, value := range args {
		if value == "--token" || strings.HasPrefix(value, "--token=") {
			return newError(categoryUsage, "Secrets are not accepted in command arguments; use --token-stdin")
		}
	}
	return nil
}

func removeFlag(args *[]string, flag string) (bool, error) {
	index := -1
	for current, value := range *args {
		if value == flag {
			if index != -1 {
				return false, newError(categoryUsage, flag+" may only be provided once")
			}
			index = current
		}
	}
	if index == -1 {
		return false, nil
	}
	*args = slices.Delete(*args, index, index+1)
	return true, nil
}

// removeOption returns "" when the option is absent; a present option always
// has a nonempty value.
func removeOption(args *[]string, option string) (string, error) {
	index := -1
	for current, value := range *args {
		if value == option {
			if index != -1 {
				return "", newError(categoryUsage, option+" may only be provided once")
			}
			index = current
		}
	}
	if index == -1 {
		return "", nil
	}
	if index+1 >= len(*args) || (*args)[index+1] == "" || strings.HasPrefix((*args)[index+1], "--") {
		return "", newError(categoryUsage, option+" requires a value")
	}
	value := (*args)[index+1]
	*args = slices.Delete(*args, index, index+2)
	return value, nil
}

func unknownCommand(args []string, commandName string) error {
	text := strings.Join(args, " ")
	if text == "" {
		text = "(empty)"
	}
	return newError(categoryUsage, fmt.Sprintf("Unknown command: %s\nRun \"%s --help\" for usage.", text, commandName))
}
