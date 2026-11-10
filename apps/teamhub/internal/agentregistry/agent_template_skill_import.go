package agentregistry

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// templateSkillImport is one template Skill reference the caller cannot bind
// from this Tenant catalog. source is set only when a copy can be made.
type templateSkillImport struct {
	binding httpapi.AgentSkillRegistration
	source  *store.GetAgentTemplateSkillSourceRow
}

// ExecuteAgentTemplateSkillImport copies a template's importable Skills into
// the Space. A repeated import reuses the copies an earlier one made.
func (s *Service) ExecuteAgentTemplateSkillImport(
	ctx context.Context, accountID, tenantID, templateID string,
) (httpapi.AgentTemplateSkillImportPage, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpapi.AgentTemplateSkillImportPage{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	caller, err := queries.AuthorizeTenantAgentTemplate(ctx, store.AuthorizeTenantAgentTemplateParams{
		TenantID: tenantID, AccountID: textValue(accountID),
	})
	if err != nil {
		return httpapi.AgentTemplateSkillImportPage{}, err
	}
	// Skill registration everywhere serializes on this lock, so the reuse check
	// below cannot race another import creating the same private copy.
	if err = queries.AcquireUnifiedSkillPolicyExclusiveLock(ctx); err != nil {
		return httpapi.AgentTemplateSkillImportPage{}, err
	}
	plan, err := planAgentTemplateSkillImports(ctx, queries, tenantID, caller.ID, templateID)
	if err != nil {
		return httpapi.AgentTemplateSkillImportPage{}, err
	}
	items := make([]httpapi.AgentTemplateSkillImport, 0, len(plan))
	for _, entry := range plan {
		if entry.source == nil {
			items = append(items, httpapi.AgentTemplateSkillImport{
				Source: entry.binding, Status: httpapi.AgentTemplateSkillImportStatusUnavailable,
			})
			continue
		}
		copied, err := copyAgentTemplateSkill(ctx, queries, tenantID, caller.ID, entry)
		if err != nil {
			return httpapi.AgentTemplateSkillImportPage{}, err
		}
		items = append(items, httpapi.AgentTemplateSkillImport{
			Source: entry.binding, Status: httpapi.AgentTemplateSkillImportStatusImported, Skill: &copied,
		})
	}
	if err = tx.Commit(ctx); err != nil {
		return httpapi.AgentTemplateSkillImportPage{}, err
	}
	return httpapi.AgentTemplateSkillImportPage{Items: items}, nil
}

// PlanAgentTemplateSkillImports lists the template's Skill references that the
// caller cannot see in this Tenant. Platform Skills and Skills the caller can
// already bind are left to normal catalog resolution. A reference is copyable
// only from a published template and only when the Skill belongs to the
// publishing Tenant: publishing is the consent that shares it.
func planAgentTemplateSkillImports(
	ctx context.Context, queries *store.Queries, tenantID, callerActorID, templateID string,
) ([]templateSkillImport, error) {
	template, err := queries.GetAgentTemplate(ctx, templateID)
	if err != nil {
		return nil, err
	}
	var bindings []httpapi.AgentSkillRegistration
	if err = json.Unmarshal(template.SkillBindings, &bindings); err != nil {
		return nil, err
	}
	plan := make([]templateSkillImport, 0, len(bindings))
	for _, binding := range bindings {
		identity, err := queries.GetSkillIdentity(ctx, binding.SkillId)
		if errors.Is(err, pgx.ErrNoRows) {
			plan = append(plan, templateSkillImport{binding: binding})
			continue
		}
		if err != nil {
			return nil, err
		}
		if identity.OwnerKind != "tenant" {
			continue
		}
		visible := identity.TenantID == tenantID &&
			(identity.AccessScope == "tenant" || identity.OwnerActorID == callerActorID)
		if visible {
			continue
		}
		entry := templateSkillImport{binding: binding}
		if template.Origin == "published" && template.TenantID.Valid && template.TenantID.String == identity.TenantID {
			source, err := queries.GetAgentTemplateSkillSource(ctx, store.GetAgentTemplateSkillSourceParams{
				TenantID: identity.TenantID, SkillID: binding.SkillId, ManifestVersion: binding.ManifestVersion,
			})
			switch {
			case err == nil && acceptsEmptySkillConfig(source.ConfigSchema):
				entry.source = &source
			case err != nil && !errors.Is(err, pgx.ErrNoRows):
				return nil, err
			}
		}
		plan = append(plan, entry)
	}
	return plan, nil
}

// Template creation binds every Skill with an empty configuration, so a Skill
// that requires configuration could never be bound from a template.
func acceptsEmptySkillConfig(schema []byte) bool {
	compiled, err := skill.ValidateManifest(schema)
	return err == nil && skill.ValidateConfig(compiled, json.RawMessage(`{}`)) == nil
}

// copyAgentTemplateSkill gives the caller a private, sealed copy of the source
// version. The immutable package objects are referenced, not duplicated.
func copyAgentTemplateSkill(
	ctx context.Context, queries *store.Queries, tenantID, callerActorID string, entry templateSkillImport,
) (httpapi.AgentSkillRegistration, error) {
	source := entry.source
	existing, err := queries.FindOwnedSkillCopy(ctx, store.FindOwnedSkillCopyParams{
		TenantID: tenantID, OwnerActorID: callerActorID, Name: source.Name, ContentHash: source.ContentHash,
	})
	if err == nil {
		return httpapi.AgentSkillRegistration{
			SkillId: existing.SkillID, ManifestVersion: existing.ManifestVersion, Name: existing.Name,
		}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return httpapi.AgentSkillRegistration{}, err
	}
	sourceFiles, err := queries.ListAgentSkillPackageFiles(ctx, source.ManifestID)
	if err != nil {
		return httpapi.AgentSkillRegistration{}, err
	}
	files := make([]skill.ManifestFile, 0, len(sourceFiles))
	for _, file := range sourceFiles {
		files = append(files, skill.ManifestFile{
			Path: file.Path, MediaType: file.MediaType, SizeBytes: file.SizeBytes,
			SHA256: hex.EncodeToString(file.Sha256), ObjectKey: file.ObjectKey,
		})
	}
	skillID := idgen.New("skill")
	if err = createOwnedTenantSkillInTx(ctx, queries, tenantID, skillID, source.Name, callerActorID); err != nil {
		return httpapi.AgentSkillRegistration{}, err
	}
	if err = publishTenantSkillManifestInTx(ctx, queries, store.CreateSkillManifestParams{
		SkillID: skillID, ManifestVersion: source.ManifestVersion, Description: source.Description,
		ConfigSchema: source.ConfigSchema, FrontmatterExtra: source.FrontmatterExtra,
		ContentHash: source.ContentHash, FileCount: source.FileCount, SizeBytes: source.SizeBytes,
		CreatedByActorID: textValue(callerActorID),
	}, files); err != nil {
		return httpapi.AgentSkillRegistration{}, err
	}
	return httpapi.AgentSkillRegistration{
		SkillId: skillID, ManifestVersion: source.ManifestVersion, Name: source.Name,
	}, nil
}

// ListAgentTemplateSkillImports reports which of a template's Skills the
// caller can import.
func (s *Service) ListAgentTemplateSkillImports(ctx context.Context, tenantID, callerID, templateID string) ([]httpapi.AgentTemplateSkillImport, error) {
	plan, err := planAgentTemplateSkillImports(ctx, s.queries, tenantID, callerID, templateID)
	if err != nil {
		return nil, err
	}
	items := make([]httpapi.AgentTemplateSkillImport, 0, len(plan))
	for _, entry := range plan {
		status := httpapi.AgentTemplateSkillImportStatusUnavailable
		if entry.source != nil {
			status = httpapi.AgentTemplateSkillImportStatusImportable
		}
		items = append(items, httpapi.AgentTemplateSkillImport{Source: entry.binding, Status: status})
	}
	return items, nil
}
