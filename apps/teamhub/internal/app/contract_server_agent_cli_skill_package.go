package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
)

// agentCLISkillPackageResult names the immutable version that was published and
// the Agent binding that now names it. binding_version is the exact saved
// revision a Sponsor applies to activate the Skill; it is not evidence that any
// Runtime loaded it.
type agentCLISkillPackageResult struct {
	SkillID         string `json:"skill_id"`
	Name            string `json:"name"`
	ManifestVersion string `json:"manifest_version"`
	BindingVersion  int64  `json:"binding_version"`
	Replayed        bool   `json:"replayed"`
}

// publishAgentCLISkillPackage publishes a package an Agent assembled in its own
// Playground. It reaches the same transaction a Sponsor upload does, so the
// resulting Skill is an ordinary immutable version with an ordinary binding the
// Sponsor can review, replace or remove.
//
// The binding is live immediately, but the Context that published it was frozen
// with its own Skill set, so the new Skill reaches the Agent's next freshly
// built Contexts (a new Room or Task) rather than the Run that published it.
func (a *App) publishAgentCLISkillPackage(c *gin.Context, tenantID, agentID, operationID, packageSHA256 string) {
	pkg, err := a.parseAgentSkillPackageBody(c, packageSHA256)
	if err != nil {
		a.writeSkillPackageUploadError(c, err)
		return
	}
	result, err := a.agents.UploadSkillPackage(c.Request.Context(), agentregistry.RuntimeSkillUploadCaller(),
		tenantID, agentID, operationID, pkg)
	if err != nil {
		a.writeAgentSkillPackageRuntimeError(c, err)
		return
	}
	// The binding model nests the Skill ID and version under "skill" and has
	// no name, so read them from there and take the name from the package the
	// Agent published, which is authoritative and non-empty. Empty fields here
	// would fail the CLI's own response validation and report a successful
	// publish as a failure.
	var binding struct {
		BindingVersion int64 `json:"binding_version"`
		Skill          struct {
			SkillID         string `json:"skill_id"`
			ManifestVersion string `json:"manifest_version"`
		} `json:"skill"`
	}
	if err = json.Unmarshal(result.Body, &binding); err != nil {
		a.internalError(c, "encode Agent Skill package result", err)
		return
	}
	c.JSON(http.StatusCreated, agentCLISkillPackageResult{
		SkillID: binding.Skill.SkillID, Name: pkg.Name, ManifestVersion: binding.Skill.ManifestVersion,
		BindingVersion: binding.BindingVersion, Replayed: result.Replay,
	})
}

// parseAgentSkillPackageBody reads the deterministic archive the Agent Service
// packed. The declared digest is verified before parsing: a package whose bytes
// changed in transit must not become an immutable version under the digest the
// Runtime reported.
func (a *App) parseAgentSkillPackageBody(c *gin.Context, declaredSHA256 string) (skill.Package, error) {
	body := http.MaxBytesReader(c.Writer, c.Request.Body, a.cfg.SkillPackageMaxArchiveBytes+1)
	defer body.Close()
	content, err := io.ReadAll(body)
	if err != nil {
		return skill.Package{}, agentregistry.ErrSkillPackageTooLarge
	}
	if int64(len(content)) > a.cfg.SkillPackageMaxArchiveBytes || len(content) == 0 {
		return skill.Package{}, agentregistry.ErrSkillPackageTooLarge
	}
	digest := sha256.Sum256(content)
	if hex.EncodeToString(digest[:]) != declaredSHA256 {
		return skill.Package{}, errors.New("Skill package digest does not match the uploaded bytes")
	}
	pkg, err := skill.ParseUploadedPackage(content, "skill.zip", skill.PackageLimits{
		MaxFiles: config.SkillPackageMaxFiles, MaxFileBytes: config.SkillPackageMaxFileBytes,
		MaxTotalBytes: config.SkillPackageMaxTotalBytes, MaxCompressionRatio: 200,
	})
	if errors.Is(err, skill.ErrPackageLimitExceeded) {
		return skill.Package{}, agentregistry.ErrSkillPackageTooLarge
	}
	return pkg, err
}

// writeAgentSkillPackageRuntimeError maps publication failures onto the CLI
// error vocabulary the Runtime already understands, so an Agent reads the same
// reason a Sponsor would.
func (a *App) writeAgentSkillPackageRuntimeError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Agent or editable bound Skill was not found")
	case errors.Is(err, agentregistry.ErrAgentSkillBindingConflict):
		a.writeError(c, http.StatusConflict, "SKILL_BINDING_CONFLICT", "Skill configuration changed; retry the same command")
	case errors.Is(err, idempotency.ErrConflict):
		a.writeError(c, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "idempotency key was used with different input")
	case errors.Is(err, agentregistry.ErrSkillPackageImmutable):
		a.writeError(c, http.StatusConflict, "SKILL_MANIFEST_IMMUTABLE", "Choose a new version; an existing version cannot be overwritten")
	case errors.Is(err, agentregistry.ErrSkillIdentityConflict):
		a.writeError(c, http.StatusConflict, "SKILL_IDENTITY_CONFLICT", "SKILL.md name must match the original Skill identity")
	case errors.Is(err, agentregistry.ErrSkillDefaultNameConflict), errors.Is(err, agentregistry.ErrAgentSkillEffectiveSetInvalid):
		a.writeError(c, http.StatusConflict, "SKILL_SET_CONFLICT", "The resulting Skill set has a name, identity, availability, or capacity conflict")
	case errors.Is(err, agentregistry.ErrSkillInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_SKILL_CONFIG", "The saved configuration is not valid for this Skill")
	case errors.Is(err, agentregistry.ErrSkillManifestInactive):
		a.writeError(c, http.StatusConflict, "SKILL_MANIFEST_INACTIVE", "The source Skill is not active")
	case errors.Is(err, agentregistry.ErrSkillPackageTooLarge):
		a.writeSkillPackageUploadError(c, err)
	default:
		a.internalError(c, "publish Agent Skill package", err)
	}
}
