package agenttemplates

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Ensure reconciles the embedded built-in templates into TeamHub. It is
// idempotent, runs under one advisory lock so concurrent startups converge,
// and never touches published templates.
func Ensure(ctx context.Context, pool *pgxpool.Pool) error {
	templates, err := Builtin()
	if err != nil {
		return err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "builtin-agent-templates"); err != nil {
		return err
	}
	kept := make([]string, 0, len(templates))
	for _, template := range templates {
		skills, err := json.Marshal(template.SkillBindings)
		if err != nil {
			return fmt.Errorf("encode built-in Agent template %s Skills: %w", template.TemplateID, err)
		}
		connectors, err := json.Marshal(template.ConnectorBindings)
		if err != nil {
			return fmt.Errorf("encode built-in Agent template %s Connectors: %w", template.TemplateID, err)
		}
		routines, err := json.Marshal(template.Routines)
		if err != nil {
			return fmt.Errorf("encode built-in Agent template %s Routines: %w", template.TemplateID, err)
		}
		avatarKey := pgtype.Text{}
		if template.AvatarKey != "" {
			avatarKey = pgtype.Text{String: template.AvatarKey, Valid: true}
		}
		if err := queries.UpsertBuiltinAgentTemplate(ctx, store.UpsertBuiltinAgentTemplateParams{
			TemplateID:        template.TemplateID,
			Name:              template.Name,
			Description:       template.Description,
			Instructions:      template.Instructions,
			AvatarKey:         avatarKey,
			SkillBindings:     skills,
			ConnectorBindings: connectors,
			Routines:          routines,
		}); err != nil {
			return fmt.Errorf("install built-in Agent template %s: %w", template.TemplateID, err)
		}
		kept = append(kept, template.TemplateID)
	}
	// A template removed from the shipped assets must disappear from the market.
	if err := queries.DeleteBuiltinAgentTemplatesOutside(ctx, kept); err != nil {
		return fmt.Errorf("retire removed built-in Agent templates: %w", err)
	}
	return tx.Commit(ctx)
}
