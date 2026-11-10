// Command proactive-event hands one outside event to a Human's proactive
// judgment by hand, standing in for a connector: the Agent Service's proactive
// judge (the Node Services address and Agent token of TeamHub's configuration) scores it
// against the Human's open Tracking Items, and it either wakes their AnotherMe
// to remind them, wakes it to record the event quietly, or stays silent. The
// decision is printed.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func main() {
	var event proactive.Event
	connectionID := flag.String("connection", "", "external connection granted to the Human's AnotherMe (required)")
	flag.StringVar(&event.TenantID, "tenant", "", "tenant ID of the Human (required)")
	flag.StringVar(&event.OwnerActorID, "actor", "", "Human actor ID (required)")
	flag.StringVar(&event.Source, "source", "", "source system, e.g. gmail, calendar, flight (required)")
	flag.StringVar(&event.ExternalID, "external-id", "", "ID of the thing in its source (required)")
	flag.StringVar(&event.State, "state", "", "current status; a new state is judged again the same day")
	flag.StringVar(&event.Kind, "kind", "", "what happened, e.g. new_mail, meeting_soon, delay (required)")
	flag.StringVar(&event.Summary, "summary", "", "what the event says (required)")
	occursAt := flag.String("occurs-at", "", "RFC 3339 time the event is about, if any")
	flag.BoolVar(&event.Urgent, "urgent", false, "pass quiet hours and the daily limit")
	flag.Parse()
	if *connectionID == "" {
		fail(fmt.Errorf("--connection is required"))
	}
	if *occursAt != "" {
		value, err := time.Parse(time.RFC3339, *occursAt)
		if err != nil {
			fail(fmt.Errorf("--occurs-at: %w", err))
		}
		event.OccursAt = &value
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cfg, err := config.Load()
	if err != nil {
		fail(err)
	}
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		fail(err)
	}
	defer pool.Close()
	// Manual injection uses the same current connection authority as a connector.
	queries := store.New(pool)
	chat, err := queries.GetAnotherMeChat(ctx, store.GetAnotherMeChatParams{
		TenantID: event.TenantID, HumanActorID: event.OwnerActorID,
	})
	if err != nil {
		fail(fmt.Errorf("resolve AnotherMe: %w", err))
	}
	if !chat.RoomID.Valid {
		fail(proactive.ErrNoDirectRoom)
	}
	grant, err := queries.LockGrantedConnectionForListener(ctx, store.LockGrantedConnectionForListenerParams{
		TenantID: event.TenantID, AgentActorID: chat.AgentActorID, ConnectionID: *connectionID,
	})
	if err != nil {
		fail(fmt.Errorf("resolve active connection grant: %w", err))
	}
	event.Grant = &reminder.GrantReference{
		ID: grant.GrantID, Revision: grant.GrantRevision, ConnectionID: *connectionID,
		AgentActorID: chat.AgentActorID, TenantID: event.TenantID,
	}
	gateway, err := roomagent.NewHTTPGateway(cfg.NodeServicesURL, cfg.NodeServicesInternalToken, nil)
	if err != nil {
		fail(err)
	}
	// The wake is queued; the running server delivers it once the Room is quiet.
	outcome, err := proactive.New(pool, proactive.AgentEventJudge(gateway.JudgeProactiveEvent), nil).HandleEvent(ctx, event)
	if err != nil {
		fail(err)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(outcome)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
