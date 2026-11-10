package agentregistry

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// ErrSkillDefaultNameConflict reports an uploaded Skill whose name belongs to a managed system default.
var ErrSkillDefaultNameConflict = errors.New("Skill name is a managed system default")

var emptySkillConfigSchema = json.RawMessage(`{"type":"object","additionalProperties":false}`)

// skillUploadCaller resolves who is publishing this package inside the
// transaction. A Sponsor is matched against the Human account on the request; an
// Agent publishing its own package has no Human request to match, so ownership
// and the idempotency scope are taken from its Sponsor instead. Everything after
// this point is identical, which is what keeps one publication path.
type skillUploadCaller func(context.Context, *store.Queries, string, string) (store.AuthorizeAgentSkillBindingWriteRow, string, error)

// SponsorSkillUploadCaller authorizes a Skill upload as the Agent's Sponsor Account.
func SponsorSkillUploadCaller(accountID string) skillUploadCaller {
	return func(ctx context.Context, q *store.Queries, tenantID, agentID string) (store.AuthorizeAgentSkillBindingWriteRow, string, error) {
		authority, err := q.AuthorizeAgentSkillBindingWrite(ctx, store.AuthorizeAgentSkillBindingWriteParams{ActorID: agentID, TenantID: tenantID, AccountID: textValue(accountID)})
		return authority, accountID, err
	}
}

// RuntimeSkillUploadCaller authorizes a Skill upload as the Agent credential in the request context.
func RuntimeSkillUploadCaller() skillUploadCaller {
	// The Runtime callback names the Agent by its management ID, the same handle
	// the tree and file publications carry. Resolve it to the actor the binding
	// tables key on so downstream reads and writes find the right Agent.
	return func(ctx context.Context, q *store.Queries, tenantID, agentID string) (store.AuthorizeAgentSkillBindingWriteRow, string, error) {
		authority, err := q.AuthorizeAgentSkillBindingRuntimeWrite(ctx, store.AuthorizeAgentSkillBindingRuntimeWriteParams{AgentManagementID: agentID, TenantID: tenantID})
		if err != nil {
			return store.AuthorizeAgentSkillBindingWriteRow{}, "", err
		}
		return store.AuthorizeAgentSkillBindingWriteRow{
			ActorID: authority.ActorID, TenantID: authority.TenantID, CallerActorID: authority.CallerActorID,
		}, authority.CallerAccountID.String, nil
	}
}

func (s *Service) uploadAgentSkillPackageTx(ctx context.Context, caller skillUploadCaller, tenantID, agentID, key string, pkg skill.Package, files []storedSkillPackageFile) (idempotency.Result, bool, error) {
	requestHash := idempotency.HashRequest(map[string]any{"package_sha256": hex.EncodeToString(pkg.SHA256[:])})
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return idempotency.Result{}, false, err
	}
	defer tx.Rollback(ctx)
	if principal, ok := agentcredential.PrincipalFromContext(ctx); ok {
		if principal.TenantID != tenantID || principal.AgentID != agentID {
			return idempotency.Result{}, false, pgx.ErrNoRows
		}
		if err := agentcredential.RevalidateInTx(ctx, tx, principal); err != nil {
			return idempotency.Result{}, false, pgx.ErrNoRows
		}
	}
	q := store.New(tx)
	if err = q.AcquireUnifiedSkillPolicyExclusiveLock(ctx); err != nil {
		return idempotency.Result{}, false, err
	}
	// The caller resolves the Agent identity: a Sponsor upload names the actor
	// directly, a Runtime upload names the management ID. Everything below keys
	// off the resolved actor so both callers reach the same binding rows.
	authority, accountID, err := caller(ctx, q, tenantID, agentID)
	if err != nil {
		return idempotency.Result{}, false, err
	}
	actorID := authority.ActorID
	operation := "uploadAgentSkillPackage:" + tenantID + ":" + actorID
	if err = q.AcquireAdvisoryTransactionLock(ctx, "agent-skill-bindings|"+actorID); err != nil {
		return idempotency.Result{}, false, err
	}
	registration, err := q.GetSkillAgentForShare(ctx, store.GetSkillAgentForShareParams{AgentActorID: actorID, TenantID: tenantID})
	if err != nil {
		return idempotency.Result{}, false, err
	}
	if replay, found, err := idempotency.Replay(ctx, tx, idempotency.AccountKey(accountID, operation, key), requestHash); err != nil {
		return idempotency.Result{}, false, err
	} else if found {
		replay.Replay = true
		return replay, false, tx.Commit(ctx)
	}
	revision, err := q.GetAgentSkillBindingVersion(ctx, actorID)
	if err != nil {
		return idempotency.Result{}, false, err
	}
	bindings, err := q.ListAgentSkillBindings(ctx, store.ListAgentSkillBindingsParams{AgentActorID: actorID, TenantID: tenantID})
	if err != nil {
		return idempotency.Result{}, false, err
	}
	var matched *store.AgentSkillBinding
	for index := range bindings {
		identity, identityErr := q.GetUnifiedSkillIdentityForUpdate(ctx, bindings[index].SkillID)
		if identityErr != nil {
			return idempotency.Result{}, false, identityErr
		}
		if identity.Name == pkg.Name {
			matched = &bindings[index]
			break
		}
	}
	if matched == nil {
		defaults, defaultErr := q.ListAllowedRequiredPlatformSkillSnapshotPackagesForAgent(ctx, actorID)
		if defaultErr != nil {
			return idempotency.Result{}, false, defaultErr
		}
		for _, item := range defaults {
			if item.PackageName == pkg.Name || item.Name == pkg.Name {
				return idempotency.Result{}, false, ErrSkillDefaultNameConflict
			}
		}
	}
	var record store.AgentSkillBinding
	if matched != nil {
		nextVersion, versionErr := nextUploadedManifestVersion(ctx, q, matched.SkillID, matched.ManifestVersion, pkg)
		if versionErr != nil {
			return idempotency.Result{}, false, versionErr
		}
		record, err = s.publishBoundSkillPackageInTx(ctx, tx, q, authority, registration, tenantID, actorID, matched.SkillID, agentSkillPackageEdit{
			ExpectedBindingVersion: revision,
			BaseManifestVersion:    matched.ManifestVersion,
			ManifestVersion:        nextVersion,
			Package:                pkg,
		}, files)
	} else {
		record, err = s.publishNewAgentSkillPackageInTx(ctx, tx, q, authority, registration, tenantID, actorID, revision, pkg, files)
	}
	if err != nil {
		return idempotency.Result{}, false, err
	}
	body, err := json.Marshal(agentSkillBindingModel(record))
	if err != nil {
		return idempotency.Result{}, false, err
	}
	if err = idempotency.Save(ctx, tx, idempotency.AccountKey(accountID, operation, key), requestHash, idempotency.Record{ResourceID: record.ID, Status: http.StatusCreated, Body: body}); err != nil {
		return idempotency.Result{}, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return idempotency.Result{}, true, errors.Join(errSkillCommitOutcomeUnknown, err)
	}
	return idempotency.Result{Status: http.StatusCreated, Body: body}, true, nil
}

func (s *Service) publishNewAgentSkillPackageInTx(ctx context.Context, tx pgx.Tx, q *store.Queries, authority store.AuthorizeAgentSkillBindingWriteRow, registration store.GetSkillAgentForShareRow, tenantID, agentID string, expectedRevision int64, pkg skill.Package, files []storedSkillPackageFile) (store.AgentSkillBinding, error) {
	revision, err := NextAgentSkillBindingVersion(ctx, q, agentID, expectedRevision)
	if err != nil {
		return store.AgentSkillBinding{}, err
	}
	skillID := idgen.New("skill")
	version := uploadedSkillVersion(pkg, "1.0.0")
	if err := createOwnedTenantSkillInTx(ctx, q, tenantID, skillID, pkg.Name, authority.CallerActorID); err != nil {
		return store.AgentSkillBinding{}, err
	}
	if err := insertSkillPackageInTx(ctx, q, authority.CallerActorID, skillPackageRegistration{
		SkillID: skillID, ManifestVersion: version, Description: pkg.Description,
		ConfigSchema: bytes.Clone(emptySkillConfigSchema), Package: pkg,
	}, files); err != nil {
		return store.AgentSkillBinding{}, err
	}
	return writeAgentSkillBindingInTx(ctx, tx, q, tenantID, agentID, skillID, authority.CallerActorID, registration.AgentType, revision, httpapi.AgentSkillBindingPutRequest{
		ExpectedBindingVersion: expectedRevision, ManifestVersion: version, Enabled: true, Config: map[string]any{},
	})
}

func nextUploadedManifestVersion(ctx context.Context, q *store.Queries, skillID, current string, pkg skill.Package) (string, error) {
	preferred := uploadedSkillVersion(pkg, "")
	if preferred != "" && preferred != current {
		exists, err := q.SkillManifestVersionExists(ctx, store.SkillManifestVersionExistsParams{SkillID: skillID, ManifestVersion: preferred})
		if err != nil {
			return "", err
		}
		if !exists {
			return preferred, nil
		}
	}
	candidate := current
	for range 32 {
		next, err := bumpPatchVersion(candidate)
		if err != nil {
			return "", err
		}
		exists, err := q.SkillManifestVersionExists(ctx, store.SkillManifestVersionExistsParams{SkillID: skillID, ManifestVersion: next})
		if err != nil {
			return "", err
		}
		if !exists {
			return next, nil
		}
		candidate = next
	}
	return "", fmt.Errorf("%w: could not allocate a new Skill version", ErrSkillPackageImmutable)
}

func uploadedSkillVersion(pkg skill.Package, fallback string) string {
	version := skill.OptionalFrontmatterVersion(pkg.Frontmatter.FrontmatterExtra)
	if SkillManifestVersionPattern.MatchString(version) {
		return version
	}
	return fallback
}

func bumpPatchVersion(version string) (string, error) {
	core := version
	if index := strings.IndexAny(version, "+-"); index >= 0 {
		core = version[:index]
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return "", errors.New("manifest version is not a patchable SemVer")
	}
	patch, err := strconv.Atoi(parts[2])
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s.%s.%d", parts[0], parts[1], patch+1), nil
}

// AuthorizeSkillPackageUpload reports pgx.ErrNoRows unless the Account may
// change the Agent's Skills; callers check it before reading an upload.
func (s *Service) AuthorizeSkillPackageUpload(ctx context.Context, accountID, tenantID, agentID string) error {
	_, err := s.queries.AuthorizeAgentSkillBindingWrite(ctx, store.AuthorizeAgentSkillBindingWriteParams{ActorID: agentID, TenantID: tenantID, AccountID: textValue(accountID)})
	return err
}

// UploadSkillPackage stages a parsed Skill package's files, binds the package
// to the Agent, and deletes the staged objects unless the transaction may
// reference them.
func (s *Service) UploadSkillPackage(ctx context.Context, caller skillUploadCaller, tenantID, agentID, key string, pkg skill.Package) (idempotency.Result, error) {
	objects, err := s.storeSkillPackageFiles(ctx, pkg)
	if err != nil {
		return idempotency.Result{}, internal("stage uploaded Skill files", err)
	}
	result, referenced, err := s.uploadAgentSkillPackageTx(ctx, caller, tenantID, agentID, key, pkg, objects)
	if !keepSkillPackageObjects(referenced, err) {
		s.deleteSkillPackageObjects(ctx, objects)
	}
	return result, err
}
