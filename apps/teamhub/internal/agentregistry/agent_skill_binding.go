package agentregistry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// ErrAgentSkillEffectiveSetInvalid reports a change that would leave an invalid effective Skill set.
var ErrAgentSkillEffectiveSetInvalid = errors.New("Agent effective Skill set is invalid")

// ErrAgentSkillBindingConflict reports a Skill binding revision that changed since the caller read it.
var ErrAgentSkillBindingConflict = errors.New("Agent Skill binding revision changed")

// PutAgentSkillBindingTx binds a sealed Skill Manifest to the Agent when its binding revision is still expected.
func (s *Service) PutAgentSkillBindingTx(ctx context.Context, accountID, tenantID, agentID, skillID string, request httpapi.AgentSkillBindingPutRequest) (httpapi.AgentSkillBinding, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpapi.AgentSkillBinding{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	if err := queries.AcquireUnifiedSkillPolicyExclusiveLock(ctx); err != nil {
		return httpapi.AgentSkillBinding{}, err
	}
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "agent-skill-bindings|"+agentID); err != nil {
		return httpapi.AgentSkillBinding{}, err
	}
	authority, err := queries.AuthorizeAgentSkillBindingWrite(ctx, store.AuthorizeAgentSkillBindingWriteParams{
		ActorID: agentID, TenantID: tenantID, AccountID: textValue(accountID),
	})
	if err != nil {
		return httpapi.AgentSkillBinding{}, err
	}
	registrationRow, err := queries.GetSkillAgentForShare(ctx, store.GetSkillAgentForShareParams{
		AgentActorID: agentID, TenantID: tenantID,
	})
	if err != nil {
		return httpapi.AgentSkillBinding{}, err
	}
	revision, err := NextAgentSkillBindingVersion(ctx, queries, agentID, request.ExpectedBindingVersion)
	if err != nil {
		return httpapi.AgentSkillBinding{}, err
	}
	if request.ReplaceSkillId != nil && *request.ReplaceSkillId != skillID {
		if _, err := queries.DeleteAgentSkillBinding(ctx, store.DeleteAgentSkillBindingParams{BindingVersion: revision, ChangedByActorID: authority.CallerActorID, AgentActorID: agentID, TenantID: tenantID, SkillID: *request.ReplaceSkillId}); err != nil {
			return httpapi.AgentSkillBinding{}, err
		}
	}
	record, err := writeAgentSkillBindingInTx(ctx, tx, queries, tenantID, agentID, skillID, authority.CallerActorID, registrationRow.AgentType, revision, request)
	if err != nil {
		return httpapi.AgentSkillBinding{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return httpapi.AgentSkillBinding{}, err
	}
	return agentSkillBindingModel(record), nil
}

func agentSkillBindingModel(record store.AgentSkillBinding) httpapi.AgentSkillBinding {
	config := map[string]any{}
	// Config is jsonb validated on write; this model builder has no error return, so fall back to an empty object.
	_ = json.Unmarshal(record.Config, &config)
	return httpapi.AgentSkillBinding{
		Id: record.ID, TenantId: record.TenantID, AgentActorId: record.AgentActorID,
		BindingVersion: record.BindingVersion, Skill: httpapi.SkillRef{
			SkillId: record.SkillID, ManifestVersion: record.ManifestVersion,
		}, Enabled: record.Enabled, Config: config, UpdatedByActorId: record.UpdatedByActorID.String, UpdatedAt: record.UpdatedAt.Time,
	}
}

// NextAgentSkillBindingVersion compares the caller's expected Agent binding
// version with the current one and returns the version the write must carry.
// The caller holds the Skill policy lock, so the current version cannot move.
func NextAgentSkillBindingVersion(ctx context.Context, q *store.Queries, agentID string, expected int64) (int64, error) {
	current, err := q.GetAgentSkillBindingVersion(ctx, agentID)
	if err != nil {
		return 0, err
	}
	if expected < 1 || current != expected {
		return 0, ErrAgentSkillBindingConflict
	}
	return current + 1, nil
}

func writeAgentSkillBindingInTx(ctx context.Context, tx pgx.Tx, queries *store.Queries, tenantID, agentID, skillID, callerActorID, agentType string, revision int64, request httpapi.AgentSkillBindingPutRequest) (store.AgentSkillBinding, error) {
	manifest, err := queries.GetExplicitBindableSkillManifest(ctx, store.GetExplicitBindableSkillManifestParams{
		TenantID: tenantID, SkillID: skillID, ManifestVersion: request.ManifestVersion, SponsorActorID: callerActorID,
	})
	if err != nil {
		return store.AgentSkillBinding{}, err
	}
	if !manifest.CurrentVersion.Bool {
		return store.AgentSkillBinding{}, ErrSkillManifestNotCurrent
	}
	if request.Enabled && manifest.State != "active" {
		return store.AgentSkillBinding{}, ErrSkillManifestInactive
	}
	config, err := json.Marshal(request.Config)
	if err != nil {
		return store.AgentSkillBinding{}, err
	}
	compiled, err := skill.ValidateManifest(manifest.ConfigSchema)
	if err != nil {
		return store.AgentSkillBinding{}, err
	}
	if err := skill.ValidateConfig(compiled, config); err != nil {
		return store.AgentSkillBinding{}, ErrSkillInvalid
	}

	record, err := queries.CreateAgentSkillBinding(ctx, store.CreateAgentSkillBindingParams{
		ID: idgen.New("agent_skill_binding"), TenantID: tenantID, AgentActorID: agentID,
		SkillID: skillID, ManifestVersion: request.ManifestVersion, Enabled: request.Enabled,
		Config: config, BindingVersion: revision, UpdatedByActorID: textValue(callerActorID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		record, err = queries.UpdateAgentSkillBinding(ctx, store.UpdateAgentSkillBindingParams{
			ManifestVersion: request.ManifestVersion, Enabled: request.Enabled, Config: config,
			BindingVersion: revision, UpdatedByActorID: callerActorID,
			AgentActorID: agentID, TenantID: tenantID, SkillID: skillID,
		})
	}
	if err != nil {
		return store.AgentSkillBinding{}, err
	}
	if err := skill.ValidateEffectiveInTx(ctx, tx, skill.Identity{
		AgentActorID: agentID, TenantID: tenantID, AgentType: agentType,
	}); err != nil {
		if errors.Is(err, skill.ErrConflict) || errors.Is(err, skill.ErrDependency) {
			return store.AgentSkillBinding{}, fmt.Errorf("%w: %v", ErrAgentSkillEffectiveSetInvalid, err) //nolint:errorlint // inner Skill errors must not match the effective-set sentinel branches ahead of this sentinel
		}
		return store.AgentSkillBinding{}, err
	}
	return record, nil
}

// ListAgentSkillBindings lists an Agent's Skill bindings for its Sponsor.
// It reports pgx.ErrNoRows when the Account may not configure the Agent.
func (s *Service) ListAgentSkillBindings(ctx context.Context, accountID, tenantID, agentID string) (httpapi.AgentSkillBindingList, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return httpapi.AgentSkillBindingList{}, internal("begin Skill configuration read", err)
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	if _, err := q.AuthorizeAgentSkillBinding(ctx, store.AuthorizeAgentSkillBindingParams{
		ActorID: agentID, TenantID: tenantID, AccountID: textValue(accountID),
	}); err != nil {
		return httpapi.AgentSkillBindingList{}, err
	}
	revision, err := q.GetAgentSkillBindingVersion(ctx, agentID)
	if err != nil {
		return httpapi.AgentSkillBindingList{}, internal("load Agent Skill binding revision", err)
	}
	rows, err := q.ListAgentSkillBindings(ctx, store.ListAgentSkillBindingsParams{
		AgentActorID: agentID, TenantID: tenantID,
	})
	if err != nil {
		return httpapi.AgentSkillBindingList{}, internal("list Agent Skill bindings", err)
	}
	items := make([]httpapi.AgentSkillBinding, 0, len(rows))
	for _, row := range rows {
		items = append(items, agentSkillBindingModel(row))
	}
	return httpapi.AgentSkillBindingList{AgentActorId: agentID, BindingVersion: revision, Items: items}, nil
}

// GetAgentSkillBinding reads one Skill binding of an Agent for its Sponsor.
func (s *Service) GetAgentSkillBinding(ctx context.Context, accountID, tenantID, agentID, skillID string) (httpapi.AgentSkillBinding, error) {
	if _, err := s.queries.AuthorizeAgentSkillBinding(ctx, store.AuthorizeAgentSkillBindingParams{
		ActorID: agentID, TenantID: tenantID, AccountID: textValue(accountID),
	}); err != nil {
		return httpapi.AgentSkillBinding{}, err
	}
	record, err := s.queries.GetAgentSkillBinding(ctx, store.GetAgentSkillBindingParams{
		AgentActorID: agentID, TenantID: tenantID, SkillID: skillID,
	})
	if err != nil {
		return httpapi.AgentSkillBinding{}, err
	}
	return agentSkillBindingModel(record), nil
}

// DeleteAgentSkillBinding removes one Skill binding when the Agent's binding
// revision is still expected.
func (s *Service) DeleteAgentSkillBinding(ctx context.Context, accountID, tenantID, agentID, skillID string, expected int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	if err := q.AcquireUnifiedSkillPolicyExclusiveLock(ctx); err != nil {
		return err
	}
	if err := q.AcquireAdvisoryTransactionLock(ctx, "agent-skill-bindings|"+agentID); err != nil {
		return err
	}
	authority, err := q.AuthorizeAgentSkillBindingWrite(ctx, store.AuthorizeAgentSkillBindingWriteParams{ActorID: agentID, TenantID: tenantID, AccountID: textValue(accountID)})
	if err != nil {
		return err
	}
	if _, err := q.GetSkillAgentForShare(ctx, store.GetSkillAgentForShareParams{
		AgentActorID: agentID, TenantID: tenantID,
	}); err != nil {
		return err
	}
	revision, err := NextAgentSkillBindingVersion(ctx, q, agentID, expected)
	if err != nil {
		return err
	}
	if _, err := q.DeleteAgentSkillBinding(ctx, store.DeleteAgentSkillBindingParams{
		BindingVersion: revision, ChangedByActorID: authority.CallerActorID,
		AgentActorID: agentID, TenantID: tenantID, SkillID: skillID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
