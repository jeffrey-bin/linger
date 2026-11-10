package computercli

import "regexp"

var environmentCommand = regexp.MustCompile(`^linger-computer-[a-z0-9][a-z0-9-]*$`)

// commandName is the command that runs this Computer. Each environment's
// launcher sets LINGER_COMPUTER_COMMAND to linger-computer-<environment>, so
// hints stay right when Computers of several environments share one machine.
func commandName(environment map[string]string) string {
	if command := environment["LINGER_COMPUTER_COMMAND"]; environmentCommand.MatchString(command) {
		return command
	}
	return "linger-computer"
}
