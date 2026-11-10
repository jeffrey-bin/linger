// account is the operator entrypoint that creates the owner of a
// single-machine install and resets its password. It is never a product route.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

const usage = "usage: go run ./cmd/account create-owner|set-password --email EMAIL --password-stdin"

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdin io.Reader, stdout io.Writer) error {
	if len(args) == 0 || (args[0] != "create-owner" && args[0] != "set-password") {
		return errors.New(usage)
	}
	command := args[0]
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	email := flags.String("email", "", "Account email")
	passwordStdin := flags.Bool("password-stdin", false, "read the password from standard input")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || *email == "" || !*passwordStdin {
		return errors.New(usage)
	}
	password, err := readPassword(stdin)
	if err != nil {
		return err
	}
	migration, err := config.LoadMigration()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, migration.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect to PostgreSQL: %w", err)
	}
	defer pool.Close()
	if command == "set-password" {
		if err := account.SetPassword(ctx, pool, *email, password); err != nil {
			return err
		}
		_, err := fmt.Fprintf(stdout, "Password updated for %s\n", *email)
		return err
	}
	created, err := account.CreateDeploymentOwner(ctx, pool, *email, password)
	if err != nil {
		return err
	}
	if created {
		_, err = fmt.Fprintf(stdout, "Created owner %s\n", *email)
	} else {
		_, err = fmt.Fprintf(stdout, "Owner %s already exists; password unchanged\n", *email)
	}
	return err
}

func readPassword(stdin io.Reader) (string, error) {
	line, err := bufio.NewReader(io.LimitReader(stdin, 4096)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("read password: %w", err)
	}
	return strings.TrimRight(line, "\r\n"), nil
}
