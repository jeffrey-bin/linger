// The installer reconciles the versioned built-in Skill catalog into TeamHub.

package skill

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"path"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

const objectKeyDomain = "teamhub.builtin-skill-object.v1\x00"

var ErrBuiltinSkillConflict = errors.New("built-in Skill conflicts with persisted state")

// currentSkillPolicy is the persisted latest Manifest version ("" before the
// first install) and default Agent Types of one catalog Skill.
type currentSkillPolicy struct {
	latestVersion     string
	defaultAgentTypes []string
}

type skillPolicyPlan struct {
	setLatest   bool
	setDefaults bool
}

// builtinSkillChange reports what startup wrote for one catalog Skill.
// latestAdvanced means an existing latest moved to the catalog bootstrap
// Manifest, so its explicit bindings must follow it.
type builtinSkillChange struct {
	changed        bool
	latestAdvanced bool
	agentTypes     []string
}

type persistedPackageFile struct {
	path      string
	mediaType string
	sizeBytes int64
	digest    []byte
	objectKey string
}

// Ensure imports the embedded built-in catalog and seeds missing lifecycle
// policy. This is the startup fast path. A sealed Manifest is skipped when its
// file rows, file count, and total size match the embedded directory; the
// installer registers file rows only after writing their objects, so a sealed
// Manifest proves its objects were written. Skipped Manifests are neither read
// nor checked against the Object Store. An uploading Manifest and a new
// Manifest take the full path, which repairs missing objects with Head
// followed by PutIfAbsent before sealing. Objects lost
// after installation are repaired with EnsureVerified or the ops command
// teamhub-skill-package-audit -repair-builtin.
//
// A Skill that is not yet in the database takes the catalog default Agent
// Types. For an existing Skill, a catalog bootstrap Manifest with a higher
// version than the current latest advances latest and re-points its enabled
// explicit bindings; an equal version only updates a changed default Agent
// Type set; a lower version (an old image during a rolling deploy) writes
// nothing. Startup does retire enabled explicit bindings of Skills that are
// already defaults for an Agent Type being revalidated, including inactive
// registrations. That drops a live custom selection; the binding row keeps
// the previous config and Manifest.
func Ensure(ctx context.Context, pool *pgxpool.Pool, objects artifactstore.ObjectStore) error {
	return ensureEmbedded(ctx, pool, objects, false)
}

// EnsureVerified runs the same installation as Ensure, but takes the full path
// for every built-in Manifest. It re-checks every persisted file against the
// Object Store and repairs missing objects. Use it for the ops repair command,
// not for every startup.
func EnsureVerified(ctx context.Context, pool *pgxpool.Pool, objects artifactstore.ObjectStore) error {
	return ensureEmbedded(ctx, pool, objects, true)
}

func ensureEmbedded(ctx context.Context, pool *pgxpool.Pool, objects artifactstore.ObjectStore, verified bool) error {
	if pool == nil || objects == nil {
		return errors.New("built-in Skill installer requires PostgreSQL and Object Store")
	}
	load := loadBuiltinDefinitions
	if verified {
		load = loadBuiltinCatalog
	}
	catalog, err := load()
	if err != nil {
		return fmt.Errorf("load built-in Skill catalog: %w", err)
	}
	return ensureCatalog(ctx, pool, objects, catalog, verified)
}

// EnsureFromFSForTest runs the fast-path installer against a bounded catalog
// fixture so integration tests can exercise persistence without importing the
// complete repository catalog.
func EnsureFromFSForTest(
	ctx context.Context,
	pool *pgxpool.Pool,
	objects artifactstore.ObjectStore,
	source fs.FS,
) error {
	return ensureFromFS(ctx, pool, objects, source, false)
}

// EnsureVerifiedFromFSForTest is EnsureFromFSForTest with full verification.
func EnsureVerifiedFromFSForTest(
	ctx context.Context,
	pool *pgxpool.Pool,
	objects artifactstore.ObjectStore,
	source fs.FS,
) error {
	return ensureFromFS(ctx, pool, objects, source, true)
}

func ensureFromFS(
	ctx context.Context,
	pool *pgxpool.Pool,
	objects artifactstore.ObjectStore,
	source fs.FS,
	verified bool,
) error {
	if pool == nil || objects == nil || source == nil {
		return errors.New("built-in Skill installer requires PostgreSQL, Object Store, and catalog filesystem")
	}
	load := loadBuiltinDefinitionsFromFS
	if verified {
		load = loadBuiltinCatalogFromFS
	}
	catalog, err := load(source)
	if err != nil {
		return fmt.Errorf("load built-in Skill catalog: %w", err)
	}
	return ensureCatalog(ctx, pool, objects, catalog, verified)
}

// persistedManifest is the part of a skill_manifests row the fast path compares
// against the embedded catalog, plus the provenance of its file rows.
type persistedManifest struct {
	skillID      string
	version      string
	packageState string
	fileCount    int
	sizeBytes    int64
	// fileRows counts the entries of the Manifest's stored file list.
	fileRows int
}

func ensureCatalog(
	ctx context.Context,
	pool *pgxpool.Pool,
	objects artifactstore.ObjectStore,
	catalog builtinCatalog,
	verified bool,
) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin built-in Skill installation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		SELECT pg_advisory_xact_lock(hashtextextended('unified-agent-skill-policy',0))
	`); err != nil {
		return fmt.Errorf("lock unified Skill policy: %w", err)
	}
	var persisted map[string]persistedManifest
	if !verified {
		persisted, err = loadPersistedManifests(ctx, tx, catalog)
		if err != nil {
			return err
		}
	}

	changedAgentTypes := make(map[string]struct{})
	var changedSkillIDs []string
	var repoints []skillRepoint
	for _, skill := range catalog.Skills {
		if _, err := tx.Exec(ctx, `
			SELECT pg_advisory_xact_lock(hashtextextended($1,0))
		`, "builtin-skill|"+skill.SkillID); err != nil {
			return fmt.Errorf("lock built-in Skill %s: %w", skill.SkillID, err)
		}
		change, err := ensureBuiltinSkill(ctx, tx, objects, catalog.source, skill, verified, persisted)
		if err != nil {
			return err
		}
		if change.changed {
			changedSkillIDs = append(changedSkillIDs, skill.SkillID)
		}
		if change.latestAdvanced {
			repoints = append(repoints, skillRepoint{skillID: skill.SkillID, manifestID: skill.BootstrapManifestID})
		}
		for _, agentType := range change.agentTypes {
			changedAgentTypes[agentType] = struct{}{}
		}
	}
	if err := repointExplicitBindings(ctx, tx, repoints); err != nil {
		return fmt.Errorf("re-point explicit bindings of advanced Skills: %w", err)
	}
	agentTypes := orderedAgentTypes(changedAgentTypes)
	if err := retireDefaultExplicitBindings(ctx, tx, agentTypes); err != nil {
		return fmt.Errorf("retire explicit bindings of default Skills: %w", err)
	}
	if err := validatePolicyConsumers(ctx, tx, changedSkillIDs, agentTypes); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit built-in Skill installation: %w", err)
	}
	return nil
}

// skillRepoint names a Skill whose latest advanced to manifestID during startup.
type skillRepoint struct {
	skillID    string
	manifestID string
}

// loadPersistedManifests reads the Manifest rows and their file-row counts for
// every catalog Manifest ID in one query. The fast path uses them to decide
// which sealed Manifests can skip package verification.
func loadPersistedManifests(
	ctx context.Context,
	tx pgx.Tx,
	catalog builtinCatalog,
) (map[string]persistedManifest, error) {
	var manifestIDs []string
	for _, skill := range catalog.Skills {
		for _, manifest := range skill.Manifests {
			manifestIDs = append(manifestIDs, manifest.ManifestID)
		}
	}
	rows, err := tx.Query(ctx, `
		SELECT manifest.manifest_id,manifest.skill_id,manifest.manifest_version,manifest.package_state,
		       manifest.file_count,manifest.size_bytes,
		       jsonb_array_length(manifest.files)
		FROM skill_manifests manifest
		WHERE manifest.manifest_id = ANY($1)
	`, manifestIDs)
	if err != nil {
		return nil, fmt.Errorf("load built-in Skill Manifests: %w", err)
	}
	defer rows.Close()

	persisted := make(map[string]persistedManifest, len(manifestIDs))
	for rows.Next() {
		var manifestID string
		var row persistedManifest
		if err := rows.Scan(&manifestID, &row.skillID, &row.version, &row.packageState, &row.fileCount, &row.sizeBytes, &row.fileRows); err != nil {
			return nil, fmt.Errorf("scan built-in Skill Manifests: %w", err)
		}
		persisted[manifestID] = row
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate built-in Skill Manifests: %w", err)
	}
	return persisted, nil
}

// sealedManifestUnchanged reports whether a persisted sealed Manifest can skip
// package verification. A sealed row for this Skill and version whose file
// count or total size differs from the embedded directory is a conflict.
// Otherwise the Manifest is skipped only when its file rows line up with the
// registered file count. Any other persisted state takes the full path, which
// owns identity conflicts and repairs missing objects.
func sealedManifestUnchanged(
	skill builtinSkill,
	manifest builtinManifest,
	row persistedManifest,
	found bool,
) (bool, error) {
	if !found || row.packageState != "sealed" || row.skillID != skill.SkillID || row.version != manifest.Version {
		return false, nil
	}
	if row.fileCount != manifest.FileCount || row.sizeBytes != manifest.SizeBytes {
		return false, fmt.Errorf(
			"%w: sealed built-in Skill %s@%s has %d files and %d bytes, embedded package has %d files and %d bytes",
			ErrBuiltinSkillConflict, skill.SkillID, manifest.Version,
			row.fileCount, row.sizeBytes, manifest.FileCount, manifest.SizeBytes,
		)
	}
	return row.fileRows == row.fileCount, nil
}

func ensureBuiltinSkill(
	ctx context.Context,
	tx pgx.Tx,
	objects artifactstore.ObjectStore,
	source fs.FS,
	skill builtinSkill,
	verified bool,
	persisted map[string]persistedManifest,
) (builtinSkillChange, error) {
	if err := ensureSkillIdentity(ctx, tx, skill); err != nil {
		return builtinSkillChange{}, err
	}
	for index := range skill.Manifests {
		manifest := &skill.Manifests[index]
		if !verified {
			row, found := persisted[manifest.ManifestID]
			unchanged, err := sealedManifestUnchanged(skill, *manifest, row, found)
			if err != nil {
				return builtinSkillChange{}, err
			}
			if unchanged {
				continue
			}
		}
		if len(manifest.Package.Files) == 0 {
			pkg, err := loadManifestPackage(source, skill.SkillID, *manifest)
			if err != nil {
				return builtinSkillChange{}, err
			}
			manifest.Package = pkg
		}
		packageState, err := ensureManifestIdentity(ctx, tx, skill, *manifest)
		if err != nil {
			return builtinSkillChange{}, err
		}
		if err := ensurePackageFiles(ctx, tx, objects, source, skill, *manifest, packageState); err != nil {
			return builtinSkillChange{}, err
		}
		if packageState == "uploading" {
			if _, err := tx.Exec(ctx, `
				UPDATE skill_manifests
				SET package_state='sealed',sealed_at=now()
				WHERE manifest_id=$1 AND package_state='uploading'
			`, manifest.ManifestID); err != nil {
				return builtinSkillChange{}, fmt.Errorf("seal built-in Skill %s@%s: %w", skill.SkillID, manifest.Version, err)
			}
		}
	}

	current, err := loadCurrentSkillPolicy(ctx, tx, skill.SkillID)
	if err != nil {
		return builtinSkillChange{}, err
	}
	bootstrapVersion, err := bootstrapManifestVersion(skill)
	if err != nil {
		return builtinSkillChange{}, err
	}
	plan, err := planSkillPolicy(current, bootstrapVersion, skill.DefaultAgentTypes)
	if err != nil {
		return builtinSkillChange{}, err
	}
	if plan.setLatest {
		if _, err := tx.Exec(ctx, `
			UPDATE skills SET latest_manifest_id=$2 WHERE skill_id=$1
		`, skill.SkillID, skill.BootstrapManifestID); err != nil {
			return builtinSkillChange{}, fmt.Errorf("select bootstrap Manifest for built-in Skill %s: %w", skill.SkillID, err)
		}
	}
	if plan.setDefaults {
		if _, err := tx.Exec(ctx, `
			UPDATE skills SET default_agent_types=$2 WHERE skill_id=$1
		`, skill.SkillID, emptyAgentTypes(skill.DefaultAgentTypes)); err != nil {
			return builtinSkillChange{}, fmt.Errorf("register built-in Skill %s defaults: %w", skill.SkillID, err)
		}
	}
	if !plan.setLatest && !plan.setDefaults {
		return builtinSkillChange{}, nil
	}
	return builtinSkillChange{
		changed:        true,
		latestAdvanced: plan.setLatest && current.latestVersion != "",
		agentTypes:     mergeAgentTypes(current.defaultAgentTypes, skill.DefaultAgentTypes),
	}, nil
}

func bootstrapManifestVersion(skill builtinSkill) (string, error) {
	for _, manifest := range skill.Manifests {
		if manifest.ManifestID == skill.BootstrapManifestID {
			return manifest.Version, nil
		}
	}
	return "", fmt.Errorf("%w: %s bootstrap Manifest %s is not in the catalog", ErrBuiltinSkillConflict, skill.SkillID, skill.BootstrapManifestID)
}

func ensureSkillIdentity(ctx context.Context, tx pgx.Tx, skill builtinSkill) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO skills(skill_id,owner_kind,name,default_agent_types)
		VALUES($1,'platform',$2,$3)
		ON CONFLICT DO NOTHING
	`, skill.SkillID, skill.Name, emptyAgentTypes(skill.DefaultAgentTypes)); err != nil {
		return fmt.Errorf("create built-in Skill %s identity: %w", skill.SkillID, err)
	}
	var ownerKind, name string
	var tenantID *string
	var defaultAgentTypes []string
	if err := tx.QueryRow(ctx, `
		SELECT owner_kind,tenant_id,name,default_agent_types
		FROM skills WHERE skill_id=$1 FOR UPDATE
	`, skill.SkillID).Scan(&ownerKind, &tenantID, &name, &defaultAgentTypes); err != nil {
		return fmt.Errorf("load built-in Skill %s identity: %w", skill.SkillID, err)
	}
	if ownerKind != "platform" || tenantID != nil || name != skill.Name {
		return fmt.Errorf("%w: %s identity differs", ErrBuiltinSkillConflict, skill.SkillID)
	}
	return nil
}

func ensureManifestIdentity(
	ctx context.Context,
	tx pgx.Tx,
	skill builtinSkill,
	manifest builtinManifest,
) (string, error) {
	pkg := manifest.Package
	if _, err := tx.Exec(ctx, `
		INSERT INTO skill_manifests(
			manifest_id,skill_id,manifest_version,description,config_schema,
			frontmatter_extra,content_hash,file_count,size_bytes,package_state
		) VALUES($1,$2,$3,$4,'{}'::jsonb,$5::jsonb,$6,$7,$8,'uploading')
		ON CONFLICT DO NOTHING
	`, manifest.ManifestID, skill.SkillID, manifest.Version, pkg.Description,
		pkg.Frontmatter.FrontmatterExtra, pkg.SHA256[:], len(pkg.Files), pkg.SizeBytes); err != nil {
		return "", fmt.Errorf("create built-in Skill %s@%s Manifest: %w", skill.SkillID, manifest.Version, err)
	}

	var manifestID, description, configSchema, packageState string
	var contentHash []byte
	var fileCount int
	var sizeBytes int64
	if err := tx.QueryRow(ctx, `
		SELECT manifest_id,description,config_schema::text,content_hash,
		       file_count,size_bytes,package_state
		FROM skill_manifests
		WHERE skill_id=$1 AND manifest_version=$2
		FOR UPDATE
	`, skill.SkillID, manifest.Version).Scan(
		&manifestID, &description, &configSchema, &contentHash,
		&fileCount, &sizeBytes, &packageState,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", fmt.Errorf(
				"%w: fixed Manifest ID %s belongs to another version",
				ErrBuiltinSkillConflict, manifest.ManifestID,
			)
		}
		return "", fmt.Errorf("load built-in Skill %s@%s Manifest: %w", skill.SkillID, manifest.Version, err)
	}
	if manifestID != manifest.ManifestID || description != pkg.Description ||
		!emptyJSONObject(configSchema) || !bytes.Equal(contentHash, pkg.SHA256[:]) ||
		fileCount != len(pkg.Files) || sizeBytes != pkg.SizeBytes ||
		(packageState != "uploading" && packageState != "sealed") {
		return "", fmt.Errorf(
			"%w: %s@%s differs from embedded content",
			ErrBuiltinSkillConflict, skill.SkillID, manifest.Version,
		)
	}
	return packageState, nil
}

func emptyJSONObject(value string) bool {
	var object map[string]json.RawMessage
	return json.Unmarshal([]byte(value), &object) == nil && object != nil && len(object) == 0
}

func ensurePackageFiles(
	ctx context.Context,
	tx pgx.Tx,
	objects artifactstore.ObjectStore,
	source fs.FS,
	skill builtinSkill,
	manifest builtinManifest,
	packageState string,
) error {
	persistedFiles, err := loadPackageFiles(ctx, tx, manifest.ManifestID)
	if err != nil {
		return err
	}
	expectedFiles := make(map[string]PackageFile, len(manifest.Package.Files))
	for _, file := range manifest.Package.Files {
		expectedFiles[file.Path] = file
	}
	persistedByPath := make(map[string]persistedPackageFile, len(persistedFiles))
	for _, persisted := range persistedFiles {
		expected, exists := expectedFiles[persisted.path]
		if !exists {
			return fmt.Errorf("%w: Manifest %s contains unexpected package file %q", ErrBuiltinSkillConflict, manifest.ManifestID, persisted.path)
		}
		if !compatibleMediaType(persisted.mediaType, expected.MediaType) || persisted.sizeBytes != expected.SizeBytes ||
			!bytes.Equal(persisted.digest, expected.SHA256[:]) || persisted.objectKey == "" {
			return fmt.Errorf("%w: package file %s:%q differs", ErrBuiltinSkillConflict, manifest.ManifestID, persisted.path)
		}
		persistedByPath[persisted.path] = persisted
	}

	stored := make([]ManifestFile, 0, len(manifest.Package.Files))
	missing := 0
	for _, file := range manifest.Package.Files {
		persisted, exists := persistedByPath[file.Path]
		objectKey := persisted.objectKey
		if !exists {
			if packageState == "sealed" {
				return fmt.Errorf("%w: sealed Manifest %s is missing %q", ErrBuiltinSkillConflict, manifest.ManifestID, file.Path)
			}
			objectKey = packageFileObjectKey(file.SHA256)
		}
		if err := ensurePackageObject(ctx, objects, source, skill, manifest, file, objectKey, exists); err != nil {
			return err
		}
		stored = append(stored, ManifestFile{
			Path: persisted.path, MediaType: persisted.mediaType, SizeBytes: persisted.sizeBytes,
			SHA256: hex.EncodeToString(persisted.digest), ObjectKey: objectKey,
		})
		if !exists {
			missing++
			stored[len(stored)-1] = NewManifestFile(file, objectKey)
		}
	}
	if missing == 0 {
		return nil
	}
	// An uploading Manifest gets its complete file list; persisted entries keep
	// their object keys.
	encoded, err := EncodeManifestFiles(stored)
	if err != nil {
		return fmt.Errorf("register built-in Skill %s@%s package files: %w", skill.SkillID, manifest.Version, err)
	}
	command, err := tx.Exec(ctx, `UPDATE skill_manifests SET files=$2 WHERE manifest_id=$1 AND package_state='uploading'`,
		manifest.ManifestID, encoded)
	if err != nil {
		return fmt.Errorf("register built-in Skill %s@%s package files: %w", skill.SkillID, manifest.Version, err)
	}
	if command.RowsAffected() != 1 {
		return fmt.Errorf("register built-in Skill %s@%s package files: Manifest is not uploading", skill.SkillID, manifest.Version)
	}
	return nil
}

// ensurePackageObject makes the content object for one package file exist. A
// full-path installation replays every built-in file, so an already persisted
// file first checks the existing object with Head; this avoids rewriting and
// fsyncing an unchanged object. Any Head failure other
// than cancellation falls through to PutIfAbsent, which stays authoritative and
// repairs a missing object.
func ensurePackageObject(
	ctx context.Context,
	objects artifactstore.ObjectStore,
	source fs.FS,
	skill builtinSkill,
	manifest builtinManifest,
	file PackageFile,
	objectKey string,
	persisted bool,
) error {
	if persisted {
		object, err := objects.Head(ctx, objectKey)
		if err == nil {
			if object.Key != objectKey || object.Size != file.SizeBytes || object.SHA256 != file.SHA256 {
				return fmt.Errorf("%w: object for %s:%q differs", ErrBuiltinSkillConflict, manifest.ManifestID, file.Path)
			}
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		// Not found or a transient error: PutIfAbsent decides.
	}
	// The upload streams from the embedded FS; the object store verifies size and digest while reading.
	embeddedPath := path.Join(manifest.PackagePath, file.Path)
	reader, err := source.Open(embeddedPath)
	if err != nil {
		return fmt.Errorf("open built-in Skill %s@%s file %q: %w", skill.SkillID, manifest.Version, embeddedPath, err)
	}
	defer reader.Close()
	object, _, err := objects.PutIfAbsent(ctx, objectKey, reader, file.SizeBytes, file.SHA256)
	if err != nil {
		if errors.Is(err, artifactstore.ErrObjectConflict) || errors.Is(err, artifactstore.ErrContentMismatch) {
			return fmt.Errorf("%w: object for %s:%q differs", ErrBuiltinSkillConflict, manifest.ManifestID, file.Path)
		}
		return fmt.Errorf("store built-in Skill %s@%s file %q: %w", skill.SkillID, manifest.Version, file.Path, err)
	}
	if object.Key != objectKey || object.Size != file.SizeBytes || object.SHA256 != file.SHA256 {
		return fmt.Errorf("object store returned invalid evidence for built-in Skill file %s:%q", manifest.ManifestID, file.Path)
	}
	return nil
}

func loadPackageFiles(
	ctx context.Context,
	tx pgx.Tx,
	manifestID string,
) ([]persistedPackageFile, error) {
	rows, err := tx.Query(ctx, `
		SELECT file.path,file.media_type,file.size_bytes,decode(file.sha256,'hex'),file.object_key
		FROM skill_manifests manifest
		CROSS JOIN LATERAL jsonb_to_recordset(manifest.files)
		  AS file(path text,media_type text,size_bytes bigint,sha256 text,object_key text)
		WHERE manifest.manifest_id=$1
		ORDER BY file.path
	`, manifestID)
	if err != nil {
		return nil, fmt.Errorf("load built-in Skill %s package files: %w", manifestID, err)
	}
	defer rows.Close()

	files := make([]persistedPackageFile, 0)
	for rows.Next() {
		var file persistedPackageFile
		if err := rows.Scan(&file.path, &file.mediaType, &file.sizeBytes, &file.digest, &file.objectKey); err != nil {
			return nil, fmt.Errorf("scan built-in Skill %s package files: %w", manifestID, err)
		}
		files = append(files, file)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate built-in Skill %s package files: %w", manifestID, err)
	}
	return files, nil
}

func compatibleMediaType(persisted, expected string) bool {
	if persisted == expected {
		return true
	}
	persistedType, persistedParameters, persistedErr := mime.ParseMediaType(persisted)
	expectedType, expectedParameters, expectedErr := mime.ParseMediaType(expected)
	return persistedErr == nil && expectedErr == nil && persistedType == expectedType &&
		len(persistedParameters) == 0 && len(expectedParameters) == 1 &&
		expectedParameters["charset"] == "utf-8"
}

func packageFileObjectKey(contentSHA256 [sha256.Size]byte) string {
	hash := sha256.New()
	_, _ = hash.Write([]byte(objectKeyDomain))
	_, _ = hash.Write(contentSHA256[:])
	return "object_" + hex.EncodeToString(hash.Sum(nil)[:16])
}

func loadCurrentSkillPolicy(ctx context.Context, tx pgx.Tx, skillID string) (currentSkillPolicy, error) {
	var current currentSkillPolicy
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(manifest.manifest_version,''),skill.default_agent_types
		FROM skills skill
		LEFT JOIN skill_manifests manifest ON manifest.manifest_id=skill.latest_manifest_id
		WHERE skill.skill_id=$1
	`, skillID).Scan(&current.latestVersion, &current.defaultAgentTypes); err != nil {
		return currentSkillPolicy{}, fmt.Errorf("load built-in Skill %s policy: %w", skillID, err)
	}
	return current, nil
}

// planSkillPolicy decides what startup writes for one catalog Skill. The first
// install selects the bootstrap Manifest as latest. For an existing Skill, a
// higher catalog bootstrap version advances latest, a lower one writes nothing
// (an old image during a rolling deploy), and an equal one keeps latest.
// Defaults are written whenever they differ from the catalog.
func planSkillPolicy(current currentSkillPolicy, catalogVersion string, catalogDefaults []string) (skillPolicyPlan, error) {
	plan := skillPolicyPlan{setDefaults: !slices.Equal(current.defaultAgentTypes, catalogDefaults)}
	if current.latestVersion == "" {
		plan.setLatest = true
		return plan, nil
	}
	order, err := compareManifestVersions(catalogVersion, current.latestVersion)
	if err != nil {
		return skillPolicyPlan{}, err
	}
	if order < 0 {
		return skillPolicyPlan{}, nil
	}
	plan.setLatest = order > 0
	return plan, nil
}

// compareManifestVersions orders two strict MAJOR.MINOR.PATCH Manifest versions
// numerically. Pre-release and build suffixes are rejected because the catalog
// installer compares only the release line.
func compareManifestVersions(left, right string) (int, error) {
	l, err := parseManifestVersion(left)
	if err != nil {
		return 0, err
	}
	r, err := parseManifestVersion(right)
	if err != nil {
		return 0, err
	}
	for index := range l {
		if l[index] != r[index] {
			if l[index] < r[index] {
				return -1, nil
			}
			return 1, nil
		}
	}
	return 0, nil
}

func parseManifestVersion(version string) ([3]uint64, error) {
	parts := strings.Split(version, ".")
	if len(parts) != 3 {
		return [3]uint64{}, fmt.Errorf("%w: Manifest version %q is not MAJOR.MINOR.PATCH", ErrBuiltinSkillConflict, version)
	}
	parsed := make([]uint64, 0, len(parts))
	for _, part := range parts {
		value, err := strconv.ParseUint(part, 10, 64)
		if err != nil || (len(part) > 1 && part[0] == '0') {
			return [3]uint64{}, fmt.Errorf("%w: Manifest version %q is not MAJOR.MINOR.PATCH", ErrBuiltinSkillConflict, version)
		}
		parsed = append(parsed, value)
	}
	return [3]uint64(parsed), nil
}

func emptyAgentTypes(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func mergeAgentTypes(left, right []string) []string {
	types := make(map[string]struct{}, len(left)+len(right))
	for _, agentType := range left {
		types[agentType] = struct{}{}
	}
	for _, agentType := range right {
		types[agentType] = struct{}{}
	}
	return orderedAgentTypes(types)
}

func orderedAgentTypes(types map[string]struct{}) []string {
	var ordered []string
	known := make(map[string]struct{}, 2)
	for _, agentType := range []string{"anotherme", "general"} {
		known[agentType] = struct{}{}
		if _, ok := types[agentType]; ok {
			ordered = append(ordered, agentType)
		}
	}
	var remaining []string
	for agentType := range types {
		if _, ok := known[agentType]; !ok {
			remaining = append(remaining, agentType)
		}
	}
	sort.Strings(remaining)
	return append(ordered, remaining...)
}
