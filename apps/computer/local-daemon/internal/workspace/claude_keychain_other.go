//go:build !darwin

package workspace

func readClaudeKeychain(string) ([]byte, error) { return nil, nil }
func removeClaudeKeychain(string) error         { return nil }
