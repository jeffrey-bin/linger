package agentregistry

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

type agentSkillPackageEdit struct {
	ExpectedBindingVersion int64
	BaseManifestVersion    string
	ManifestVersion        string
	Package                skill.Package
}

func privateEditedSkillID(tenantID, ownerActorID, sourceSkillID string) string {
	digest := sha256.Sum256([]byte(tenantID + "\x00" + ownerActorID + "\x00" + sourceSkillID))
	return "private_" + base64.RawURLEncoding.EncodeToString(digest[:])
}

func (s *Service) publishBoundSkillPackageInTx(ctx context.Context, tx pgx.Tx, q *store.Queries, authority store.AuthorizeAgentSkillBindingWriteRow, registration store.GetSkillAgentForShareRow, tenantID, agentID, skillID string, edit agentSkillPackageEdit, files []storedSkillPackageFile) (store.AgentSkillBinding, error) {
	revision, err := NextAgentSkillBindingVersion(ctx, q, agentID, edit.ExpectedBindingVersion)
	if err != nil {
		return store.AgentSkillBinding{}, err
	}
	sourceBinding, err := q.GetAgentSkillBinding(ctx, store.GetAgentSkillBindingParams{AgentActorID: agentID, TenantID: tenantID, SkillID: skillID})
	if err != nil {
		return store.AgentSkillBinding{}, err
	}
	if sourceBinding.ManifestVersion != edit.BaseManifestVersion {
		return store.AgentSkillBinding{}, ErrAgentSkillBindingConflict
	}
	source, err := q.GetExplicitBindableSkillManifest(ctx, store.GetExplicitBindableSkillManifestParams{TenantID: tenantID, SkillID: skillID, ManifestVersion: edit.BaseManifestVersion, SponsorActorID: authority.CallerActorID})
	if err != nil {
		return store.AgentSkillBinding{}, err
	}
	if source.State != "active" {
		return store.AgentSkillBinding{}, ErrSkillManifestInactive
	}
	if source.Name != edit.Package.Name {
		return store.AgentSkillBinding{}, ErrSkillIdentityConflict
	}
	identity, err := q.GetUnifiedSkillIdentityForUpdate(ctx, skillID)
	if err != nil {
		return store.AgentSkillBinding{}, err
	}
	targetID := skillID
	if identity.AccessScope != "owner" || identity.OwnerActorID != authority.CallerActorID {
		targetID = privateEditedSkillID(tenantID, authority.CallerActorID, skillID)
	}
	target, err := q.GetUnifiedSkillIdentityForUpdate(ctx, targetID)
	if err == nil && (target.OwnerKind != "tenant" || target.TenantID != tenantID || target.AccessScope != "owner" || target.OwnerActorID != authority.CallerActorID || target.Name != edit.Package.Name) {
		return store.AgentSkillBinding{}, ErrSkillIdentityConflict
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if err = createOwnedTenantSkillInTx(ctx, q, tenantID, targetID, edit.Package.Name, authority.CallerActorID); err != nil {
			return store.AgentSkillBinding{}, err
		}
	} else if err != nil {
		return store.AgentSkillBinding{}, err
	}
	exists, err := q.SkillManifestVersionExists(ctx, store.SkillManifestVersionExistsParams{SkillID: targetID, ManifestVersion: edit.ManifestVersion})
	if err != nil {
		return store.AgentSkillBinding{}, err
	}
	if exists {
		return store.AgentSkillBinding{}, ErrSkillPackageImmutable
	}
	registrationPackage := skillPackageRegistration{SkillID: targetID, ManifestVersion: edit.ManifestVersion, Description: edit.Package.Description, ConfigSchema: source.ConfigSchema, Package: edit.Package}
	if err = insertSkillPackageInTx(ctx, q, authority.CallerActorID, registrationPackage, files); err != nil {
		return store.AgentSkillBinding{}, err
	}
	// Remove the shared binding BEFORE effective-set validation (the private fork keeps its runtime name).
	if targetID != skillID {
		if _, err = q.DeleteAgentSkillBinding(ctx, store.DeleteAgentSkillBindingParams{BindingVersion: revision, ChangedByActorID: authority.CallerActorID, AgentActorID: agentID, TenantID: tenantID, SkillID: skillID}); err != nil {
			return store.AgentSkillBinding{}, err
		}
	}
	config, err := decodeJSONObject(sourceBinding.Config)
	if err != nil {
		return store.AgentSkillBinding{}, err
	}
	return writeAgentSkillBindingInTx(ctx, tx, q, tenantID, agentID, targetID, authority.CallerActorID, registration.AgentType, revision, httpapi.AgentSkillBindingPutRequest{ExpectedBindingVersion: edit.ExpectedBindingVersion, ManifestVersion: edit.ManifestVersion, Enabled: sourceBinding.Enabled, Config: config})
}
