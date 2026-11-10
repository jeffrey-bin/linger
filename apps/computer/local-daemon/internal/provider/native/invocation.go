package native

import "sort"

// Invocation is how a CLI is called: a program, wrapper arguments placed
// before every call's own arguments, and the child environment. A nil Env
// inherits the host environment; a non-nil empty Env inherits nothing.
type Invocation struct {
	Program string
	Leading []string
	Env     []string
}

func NewInvocation(program string, leading []string) Invocation {
	return Invocation{Program: program, Leading: append([]string(nil), leading...)}
}

// Args returns a fresh argv tail: Leading followed by args.
func (i Invocation) Args(args ...string) []string {
	out := make([]string, 0, len(i.Leading)+len(args))
	out = append(out, i.Leading...)
	return append(out, args...)
}

// WithEnvironment returns a copy whose Env is env rendered as sorted
// KEY=VALUE entries. An empty or nil map yields an empty, non-inheriting Env.
func (i Invocation) WithEnvironment(env map[string]string) Invocation {
	out := i
	out.Leading = append([]string(nil), i.Leading...)
	out.Env = renderEnvironment(env)
	return out
}

func renderEnvironment(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+env[key])
	}
	return out
}
