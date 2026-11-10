package agentregistry

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"

	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func decodeJSONObject(content []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	var object map[string]any
	if err := decoder.Decode(&object); err != nil || object == nil {
		return nil, errors.New("expected a JSON object")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("unexpected content after JSON object")
	}
	return object, nil
}

func keepSkillPackageObjects(referenced bool, err error) bool {
	// Keep these objects only when the transaction may already reference them; other failures are compensated by the caller deleting them.
	return referenced && (err == nil || errors.Is(err, errSkillCommitOutcomeUnknown))
}

// SkillManifestModel lists a Manifest under the requested Tenant. A Manifest
// never changes after it is sealed, so its creator and seal time are also its
// last update.
func SkillManifestModel(tenantID string, row store.ListBindableSkillManifestsRow) httpapi.SkillManifest {
	config := map[string]any{}
	// ConfigSchema is jsonb validated on write; this model builder has no error return, so fall back to an empty object.
	_ = json.Unmarshal(row.ConfigSchema, &config)
	result := httpapi.SkillManifest{
		TenantId: tenantID, SkillId: row.SkillID, ManifestVersion: row.ManifestVersion,
		Name: row.Name, Description: row.Description, ConfigSchema: config,
		PackageName: row.Name, PackageSha256: hex.EncodeToString(row.ContentHash),
		FileCount: int(row.FileCount), SizeBytes: row.SizeBytes,
		AccessScope:      httpapi.SkillManifestAccessScope(row.AccessScope),
		Availability:     httpapi.SkillManifestAvailability(row.Availability),
		CreatedByActorId: row.CreatedByActorID.String, UpdatedByActorId: row.CreatedByActorID.String,
		CreatedAt: row.CreatedAt.Time, UpdatedAt: row.SealedAt.Time,
	}
	if row.OwnerActorID.Valid {
		ownerID := row.OwnerActorID.String
		result.OwnerActorId = &ownerID
	}
	return result
}

// createOwnedTenantSkillInTx creates the identity of a new Tenant Skill that
// only ownerActorID can see.
func createOwnedTenantSkillInTx(ctx context.Context, queries *store.Queries, tenantID, skillID, name, ownerActorID string) error {
	return queries.CreateTenantSkill(ctx, store.CreateTenantSkillParams{
		SkillID: skillID, TenantID: textValue(tenantID), Name: name, AccessScope: "owner",
		OwnerActorID: textValue(ownerActorID), CreatedByActorID: textValue(ownerActorID),
	})
}

// insertSkillPackageInTx publishes an uploaded or edited package as a new
// version of an existing Tenant Skill identity.
func insertSkillPackageInTx(ctx context.Context, queries *store.Queries, actorID string, registration skillPackageRegistration, files []storedSkillPackageFile) error {
	references := make([]skill.ManifestFile, 0, len(files))
	for _, file := range files {
		references = append(references, skill.NewManifestFile(file.File, file.Object.Key))
	}
	return publishTenantSkillManifestInTx(ctx, queries, store.CreateSkillManifestParams{
		SkillID: registration.SkillID, ManifestVersion: registration.ManifestVersion,
		Description: registration.Description, ConfigSchema: registration.ConfigSchema,
		FrontmatterExtra: registration.Package.Frontmatter.FrontmatterExtra,
		ContentHash:      registration.Package.SHA256[:], FileCount: int32(len(files)),
		SizeBytes: registration.Package.SizeBytes, CreatedByActorID: textValue(actorID),
	}, references)
}

// publishTenantSkillManifestInTx publishes one active Manifest and its
// immutable file references in the caller's transaction. Object storage is
// staged before the transaction; its caller owns compensation/unknown-commit
// recovery.
func publishTenantSkillManifestInTx(ctx context.Context, queries *store.Queries, manifest store.CreateSkillManifestParams, files []skill.ManifestFile) error {
	encoded, err := skill.EncodeManifestFiles(files)
	if err != nil {
		return err
	}
	manifest.ManifestID = idgen.New("skill_manifest")
	manifest.Files = encoded
	if err := queries.CreateSkillManifest(ctx, manifest); err != nil {
		return err
	}
	// Sealing checks the file list against the Manifest's count, size and
	// hash; a new Manifest starts active.
	return queries.SealSkillManifest(ctx, manifest.ManifestID)
}

// ListSkillManifests lists one page of the Skill Manifests the caller may
// bind, ordered by Skill and version.
func (s *Service) ListSkillManifests(ctx context.Context, tenantID, callerID, cursorSkill, cursorVersion string, limit int32) (httpapi.SkillManifestPage, error) {
	rows, err := s.queries.ListBindableSkillManifests(ctx, store.ListBindableSkillManifestsParams{
		TenantID: tenantID, CallerActorID: callerID,
		CursorSkillID: cursorSkill, CursorManifestVersion: cursorVersion, PageLimit: limit + 1,
	})
	if err != nil {
		return httpapi.SkillManifestPage{}, internal("list skill manifests", err)
	}
	items := make([]httpapi.SkillManifest, 0, len(rows))
	for _, row := range rows {
		items = append(items, SkillManifestModel(tenantID, row))
	}
	hasMore := len(items) > int(limit)
	if hasMore {
		items = items[:limit]
	}
	page := httpapi.PageMeta{HasMore: hasMore}
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		next := encodeSkillCursor(last.SkillId, last.ManifestVersion)
		page.NextCursor = &next
	}
	return httpapi.SkillManifestPage{Items: items, Page: page}, nil
}
