package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestRunRejectsIncompleteCommandsBeforeConnecting(t *testing.T) {
	t.Setenv("TEAMHUB_DATABASE_URL", "")
	for name, args := range map[string][]string{
		"no command":       nil,
		"unknown command":  {"delete-owner", "--email", "owner@example.test", "--password-stdin"},
		"missing email":    {"create-owner", "--password-stdin"},
		"password as flag": {"create-owner", "--email", "owner@example.test", "--password", "secret"},
		"no stdin flag":    {"set-password", "--email", "owner@example.test"},
		"extra argument":   {"create-owner", "--email", "owner@example.test", "--password-stdin", "extra"},
	} {
		t.Run(name, func(t *testing.T) {
			err := run(context.Background(), args, strings.NewReader("password1\n"), &bytes.Buffer{})
			if err == nil || err.Error() != usage {
				t.Fatalf("err = %v, want usage", err)
			}
		})
	}
}

func TestReadPasswordStripsOneLineEnding(t *testing.T) {
	for input, want := range map[string]string{
		"secret-pass\n":   "secret-pass",
		"secret-pass\r\n": "secret-pass",
		"secret-pass":     "secret-pass",
		" spaced pass \n": " spaced pass ",
	} {
		got, err := readPassword(strings.NewReader(input))
		if err != nil || got != want {
			t.Fatalf("readPassword(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
}
