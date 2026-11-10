package agentregistry

import (
	"bytes"
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

var internal = collaboration.Internal

// AgentIdentity resolves the identity Agent Service runs an active Agent as.
// It reports pgx.ErrNoRows for an unknown Agent.
func (s *Service) AgentIdentity(ctx context.Context, agentID string) (teamhubinternal.AgentIdentity, error) {
	registration, err := s.queries.GetAgentRegistrationForIdentityByExternalID(ctx, textValue(agentID))
	if err != nil {
		return teamhubinternal.AgentIdentity{}, err
	}
	actor, err := s.queries.GetActor(ctx, store.GetActorParams{
		ID: registration.ActorID, TenantID: registration.TenantID,
	})
	if err != nil {
		return teamhubinternal.AgentIdentity{}, err
	}
	if actor.Kind != "agent" || !registration.AgentManagementID.Valid || registration.AgentManagementID.String == "" {
		return teamhubinternal.AgentIdentity{}, internal("validate Agent identity", errors.New("active Agent registration identity is invalid"))
	}
	sponsor, err := s.queries.GetActor(ctx, store.GetActorParams{
		ID: registration.CreatedByActorID, TenantID: registration.TenantID,
	})
	if err != nil {
		return teamhubinternal.AgentIdentity{}, internal("resolve Agent sponsor identity", err)
	}
	if sponsor.Kind != "human" || !sponsor.AccountID.Valid || sponsor.AccountID.String == "" {
		return teamhubinternal.AgentIdentity{}, internal("validate Agent sponsor identity", errors.New("active Agent registration sponsor identity is invalid"))
	}
	representedHuman, err := s.agentRepresentedHumanIdentity(ctx, AgentRegistrationFromRecord(store.GetAgentRegistrationRow(registration)))
	if err != nil {
		return teamhubinternal.AgentIdentity{}, internal("resolve AnotherMe represented Human identity", err)
	}
	return teamhubinternal.AgentIdentity{
		AgentId:   registration.AgentManagementID.String,
		AgentType: teamhubinternal.AgentType(registration.AgentType),
		Actor: teamhubinternal.AgentActorRef{
			Id:   actor.ID,
			Kind: teamhubinternal.ActorKind(actor.Kind), DisplayName: actor.DisplayName,
		},
		Sponsor: teamhubinternal.AgentSponsorRef{
			Id: sponsor.ID, DisplayName: sponsor.DisplayName,
		},
		RepresentedHuman: representedHuman,
	}, nil
}

// ErrInvalidAgentCursor reports a directory cursor that names no listed Agent.
var ErrInvalidAgentCursor = errors.New("Agent directory cursor is invalid")

// DirectoryPage is one cursor page of the Tenant Agent directory.
type DirectoryPage struct {
	Cursor string
	Limit  int32
}

func (s *Service) tenantAgentDirectoryPage(ctx context.Context, accountID, tenantID, action string, page DirectoryPage) ([]store.ListTenantAgentsForAccountRow, bool, error) {
	if page.Cursor != "" {
		exists, err := s.queries.AgentRegistrationCursorExists(ctx, store.AgentRegistrationCursorExistsParams{
			ActorID: page.Cursor, TenantID: tenantID, AccountID: accountID,
		})
		if err != nil {
			return nil, false, internal("validate Tenant Agent directory cursor", err)
		}
		if !exists {
			return nil, false, ErrInvalidAgentCursor
		}
	}
	rows, err := s.queries.ListTenantAgentsForAccount(ctx, store.ListTenantAgentsForAccountParams{
		TenantID: tenantID, AccountID: accountID, Cursor: page.Cursor, PageLimit: page.Limit + 1,
	})
	if err != nil {
		return nil, false, internal(action, err)
	}
	hasMore := len(rows) > int(page.Limit)
	if hasMore {
		rows = rows[:page.Limit]
	}
	return rows, hasMore, nil
}

func directoryPageMeta(hasMore bool, rows []store.ListTenantAgentsForAccountRow) httpapi.PageMeta {
	meta := httpapi.PageMeta{HasMore: hasMore}
	if hasMore && len(rows) > 0 {
		cursor := rows[len(rows)-1].ActorID
		meta.NextCursor = &cursor
	}
	return meta
}

// ListTenantAgents lists the Tenant's Agents the Account can see, with their
// Skill bindings and avatar image versions.
func (s *Service) ListTenantAgents(ctx context.Context, accountID, tenantID string, page DirectoryPage) (httpapi.TenantAgentPage, error) {
	rows, hasMore, err := s.tenantAgentDirectoryPage(ctx, accountID, tenantID, "list Tenant Agents", page)
	if err != nil {
		return httpapi.TenantAgentPage{}, err
	}
	actorIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		actorIDs = append(actorIDs, row.ActorID)
	}
	skillBindings, err := listAgentRegistrationBindings(ctx, s.queries, actorIDs)
	if err != nil {
		return httpapi.TenantAgentPage{}, internal("list Tenant Agent bindings", err)
	}
	images, err := AgentAvatarImageVersions(ctx, s.queries, tenantID, actorIDs)
	if err != nil {
		return httpapi.TenantAgentPage{}, internal("list Tenant Agent avatar images", err)
	}
	items := make([]httpapi.TenantAgent, 0, len(rows))
	for _, row := range rows {
		items = append(items, withAgentAvatarImage(listedTenantAgentModel(row, skillBindings[row.ActorID]), images))
	}
	return httpapi.TenantAgentPage{Items: items, Page: directoryPageMeta(hasMore, rows)}, nil
}

// ListTenantAgentAvailability lists the availability of the Tenant's Agents
// the Account can see, from the Local Computer observations TeamHub stored.
func (s *Service) ListTenantAgentAvailability(ctx context.Context, accountID, tenantID string, page DirectoryPage) (httpapi.TenantAgentAvailabilityPage, error) {
	rows, hasMore, err := s.tenantAgentDirectoryPage(ctx, accountID, tenantID, "list Tenant Agent availability", page)
	if err != nil {
		return httpapi.TenantAgentAvailabilityPage{}, err
	}
	localRuntimeStatuses := s.persistedLocalAgentRuntimeStatuses(ctx, tenantID, rows)
	items := make([]httpapi.TenantAgentAvailabilitySnapshot, 0, len(rows))
	for _, row := range rows {
		status, found := localRuntimeStatuses[row.ActorID]
		if !found {
			status = unavailableLocalAgentRuntimeStatus(row)
		}
		runtimeStatus := localAgentRuntimeStatusModel(status)
		items = append(items, httpapi.TenantAgentAvailabilitySnapshot{
			ActorId:            row.ActorID,
			Availability:       availabilityWithLocalRuntimeStatus(listedTenantAgentAvailability(row), status),
			LocalRuntimeStatus: &runtimeStatus,
		})
	}
	return httpapi.TenantAgentAvailabilityPage{Items: items, Page: directoryPageMeta(hasMore, rows)}, nil
}

// ListAgentTemplates lists the built-in and published Agent templates.
func (s *Service) ListAgentTemplates(ctx context.Context) ([]httpapi.AgentTemplate, error) {
	rows, err := s.queries.ListAgentTemplates(ctx)
	if err != nil {
		return nil, internal("list Agent templates", err)
	}
	items := make([]httpapi.AgentTemplate, 0, len(rows))
	for _, row := range rows {
		model, err := listedAgentTemplateModel(row)
		if err != nil {
			return nil, internal("decode Agent template", err)
		}
		items = append(items, model)
	}
	return items, nil
}

// ErrAgentTemplateNotOwned reports a template that was not published from
// the caller's Space.
var ErrAgentTemplateNotOwned = errors.New("Agent template was not published from this Space")

// DeleteAgentTemplate removes a template published out of the Space. Removing
// an absent template succeeds: it is the state the caller asked for.
func (s *Service) DeleteAgentTemplate(ctx context.Context, tenantID, templateID string) error {
	owner, err := s.queries.GetAgentTemplateOwner(ctx, templateID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil
	case err != nil:
		return internal("load Agent template", err)
	}
	// The Space's Human removes templates published out of this Space, never
	// built-in ones or another deployment's.
	if owner.Origin != "published" || !owner.TenantID.Valid || owner.TenantID.String != tenantID {
		return ErrAgentTemplateNotOwned
	}
	if _, err := s.queries.DeletePublishedAgentTemplate(ctx, templateID); err != nil {
		return internal("delete Agent template", err)
	}
	return nil
}

// AvatarImage is an uploaded Agent avatar with its immutable version.
type AvatarImage struct {
	ContentType string
	Body        []byte
	Version     string
}

// ErrAvatarImageNotFound reports an Agent without a visible uploaded avatar.
var ErrAvatarImageNotFound = errors.New("Agent avatar image was not found")

// AgentAvatarImage reads the uploaded avatar of an Agent the Account can see.
func (s *Service) AgentAvatarImage(ctx context.Context, accountID, tenantID, actorID string) (AvatarImage, error) {
	row, err := s.queries.GetVisibleAgentAvatarImage(ctx, store.GetVisibleAgentAvatarImageParams{
		AccountID: accountID, TenantID: tenantID, ActorID: actorID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return AvatarImage{}, ErrAvatarImageNotFound
	}
	if err != nil {
		return AvatarImage{}, internal("read Agent avatar image", err)
	}
	contentType, body, ok := decodeAgentAvatarImage(row.AvatarImage)
	if !ok {
		return AvatarImage{}, internal("decode Agent avatar image", errors.New("stored avatar image is not a valid data URL"))
	}
	return AvatarImage{ContentType: contentType, Body: body, Version: agentAvatarImageVersion(row.UpdatedAt)}, nil
}

// ErrAgentResourceForbidden reports an Agent whose identity cannot read its
// resources.
var ErrAgentResourceForbidden = errors.New("Agent resource identity is invalid")

func authorizeAgentResourceRead(ctx context.Context, q *store.Queries, agentID string) (store.GetActiveAgentRegistrationByExternalIDRow, error) {
	registration, err := q.GetActiveAgentRegistrationByExternalID(ctx, textValue(agentID))
	if err != nil {
		return registration, err
	}
	actor, err := q.GetActor(ctx, store.GetActorParams{ID: registration.ActorID, TenantID: registration.TenantID})
	if err != nil {
		return registration, err
	}
	sponsor, err := q.GetActor(ctx, store.GetActorParams{ID: registration.CreatedByActorID, TenantID: registration.TenantID})
	if err != nil {
		return registration, err
	}
	if actor.Kind != "agent" || sponsor.Kind != "human" || !sponsor.AccountID.Valid {
		return registration, ErrAgentResourceForbidden
	}
	return registration, nil
}

// EffectiveResources resolves the Skills and Connected Apps an active Agent
// runs with. Skill set conflicts report skill.ErrConflict or
// skill.ErrDependency.
func (s *Service) EffectiveResources(ctx context.Context, agentID string, connectedApps bool) (teamhubinternal.AgentEffectiveResources, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return teamhubinternal.AgentEffectiveResources{}, internal("begin Agent resource read", err)
	}
	defer tx.Rollback(ctx)
	registration, err := authorizeAgentResourceRead(ctx, store.New(tx), agentID)
	if err != nil {
		return teamhubinternal.AgentEffectiveResources{}, err
	}
	items, digest, err := skill.ResolveEffectiveInTx(ctx, tx, skill.Identity{
		AgentID: agentID, AgentActorID: registration.ActorID, TenantID: registration.TenantID, AgentType: registration.AgentType,
	})
	if errors.Is(err, skill.ErrConflict) || errors.Is(err, skill.ErrDependency) {
		return teamhubinternal.AgentEffectiveResources{}, err
	}
	if err != nil {
		return teamhubinternal.AgentEffectiveResources{}, internal("resolve Agent Skill configuration", err)
	}
	result := teamhubinternal.AgentEffectiveResources{
		EffectiveSha256: EffectiveResourcesDigest(digest, connectedApps), ConnectedApps: connectedApps,
		Skills: make([]teamhubinternal.AgentEffectiveSkill, 0, len(items)),
	}
	for _, item := range items {
		result.Skills = append(result.Skills, teamhubinternal.AgentEffectiveSkill{SkillId: item.SkillID, ManifestId: item.ManifestID, ManifestVersion: item.ManifestVersion, Name: item.Name, PackageSha256: item.PackageSHA256, Source: teamhubinternal.AgentEffectiveSkillSource(item.Source), Config: item.Config})
	}
	return result, nil
}

// SkillPackageDownload is one immutable Skill package as a ZIP archive.
type SkillPackageDownload struct {
	Name        string
	ContentHash []byte
	Archive     []byte
}

// ErrSkillPackageForbidden reports a Skill package the Agent may not read.
var ErrSkillPackageForbidden = errors.New("the Agent cannot download this Skill package")

// AgentSkillManifestPackage builds one immutable Skill package the Agent may
// read, for the Agent's Computer under the Agent credential it holds.
func (s *Service) AgentSkillManifestPackage(ctx context.Context, agentID, manifestID string) (SkillPackageDownload, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return SkillPackageDownload{}, internal("begin Agent Skill package read", err)
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	registration, err := authorizeAgentResourceRead(ctx, q, agentID)
	if err != nil {
		return SkillPackageDownload{}, err
	}
	manifest, err := q.GetAgentSkillPackageManifest(ctx, manifestID)
	if err != nil {
		return SkillPackageDownload{}, err
	}
	visible := manifest.OwnerKind == "platform" && !manifest.TenantID.Valid || manifest.OwnerKind == "tenant" && manifest.TenantID.String == registration.TenantID && (manifest.AccessScope == "tenant" || manifest.OwnerActorID.String == registration.CreatedByActorID)
	if !visible || manifest.PackageState != "sealed" || manifest.State == "revoked" {
		return SkillPackageDownload{}, ErrSkillPackageForbidden
	}
	rows, err := q.ListAgentSkillPackageFiles(ctx, manifest.ManifestID)
	if err != nil {
		return SkillPackageDownload{}, internal("read immutable Skill package files", err)
	}
	if len(rows) == 0 || len(manifest.ContentHash) != 32 {
		return SkillPackageDownload{}, internal("validate Skill package metadata", errors.New("sealed package metadata is incomplete"))
	}
	// No mutable policy is written or retained while package objects are read.
	if err := tx.Commit(ctx); err != nil {
		return SkillPackageDownload{}, internal("finish Skill package authorization", err)
	}
	files := make([]skill.PackageFile, 0, len(rows))
	for _, row := range rows {
		content, err := s.readSkillPackageObject(ctx, row.ObjectKey, row.SizeBytes, row.Sha256)
		if err != nil {
			return SkillPackageDownload{}, internal("read Agent Skill package object", err)
		}
		files = append(files, skill.PackageFile{Path: row.Path, MediaType: row.MediaType, SizeBytes: row.SizeBytes, Content: content})
	}
	var output bytes.Buffer
	if err := writeSkillPackageZIP(&output, manifest.Name, files); err != nil {
		return SkillPackageDownload{}, internal("build Agent Skill package", err)
	}
	return SkillPackageDownload{Name: manifest.Name, ContentHash: manifest.ContentHash, Archive: output.Bytes()}, nil
}
