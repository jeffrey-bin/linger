// agent-credential is the operator entrypoint that revokes an Agent's TeamHub
// CLI credentials, for example after a token leaked. It is never a product
// route.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

const usage = "usage: go run ./cmd/agent-credential revoke --agent-id AGENT_ID"

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) == 0 || args[0] != "revoke" {
		return errors.New(usage)
	}
	flags := flag.NewFlagSet("revoke", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	agentID := flags.String("agent-id", "", "Agent ID")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || *agentID == "" {
		return errors.New(usage)
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
	revoked, err := agentcredential.New(pool).RevokeAgent(ctx, *agentID)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "Revoked %d credentials of Agent %s\n", revoked, *agentID)
	return err
}
