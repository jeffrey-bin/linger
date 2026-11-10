package app

import (
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

func (a *App) uploadAgentSkillPackage(c *gin.Context) {
	accountID, tenantID, agentID := currentPrincipal(c).Session.AccountID, c.Param("tenantId"), c.Param("agentId")
	if err := a.agents.AuthorizeSkillPackageUpload(c.Request.Context(), accountID, tenantID, agentID); a.notFoundOrError(c, "authorize Skill package upload", err) {
		return
	}
	key, ok := a.requireIdempotencyKey(c)
	if !ok {
		return
	}
	pkg, err := a.parseAgentSkillPackageUpload(c)
	if err != nil {
		a.writeSkillPackageUploadError(c, err)
		return
	}
	result, err := a.agents.UploadSkillPackage(c.Request.Context(), agentregistry.SponsorSkillUploadCaller(accountID), tenantID, agentID, key, pkg)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Agent or editable bound Skill was not found")
	case errors.Is(err, agentregistry.ErrAgentSkillBindingConflict):
		a.writeError(c, http.StatusConflict, "SKILL_BINDING_CONFLICT", "Skill configuration changed; reload before saving")
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
	case a.notFoundOrError(c, "upload Agent Skill package", err):
	default:
		writeResultResponse(c, result)
	}
}

func (a *App) parseAgentSkillPackageUpload(c *gin.Context) (skill.Package, error) {
	if err := extendUploadReadDeadline(c); err != nil {
		return skill.Package{}, err
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, a.cfg.SkillPackageMaxArchiveBytes+(1<<20))
	if err := c.Request.ParseMultipartForm(a.cfg.SkillPackageMaxArchiveBytes + (1 << 20)); err != nil {
		return skill.Package{}, agentregistry.ErrSkillPackageTooLarge
	}
	defer c.Request.MultipartForm.RemoveAll()
	if len(c.Request.MultipartForm.Value) > 0 {
		return skill.Package{}, errors.New("unexpected Skill upload field")
	}
	for key, files := range c.Request.MultipartForm.File {
		if key != "package" || len(files) != 1 {
			return skill.Package{}, errors.New("unexpected Skill upload file")
		}
	}
	file, header, err := c.Request.FormFile("package")
	if err != nil {
		return skill.Package{}, err
	}
	defer file.Close()
	if header.Size <= 0 || header.Size > a.cfg.SkillPackageMaxArchiveBytes {
		return skill.Package{}, agentregistry.ErrSkillPackageTooLarge
	}
	content, err := io.ReadAll(io.LimitReader(file, a.cfg.SkillPackageMaxArchiveBytes+1))
	if err != nil {
		return skill.Package{}, err
	}
	if int64(len(content)) > a.cfg.SkillPackageMaxArchiveBytes {
		return skill.Package{}, agentregistry.ErrSkillPackageTooLarge
	}
	pkg, err := skill.ParseUploadedPackage(content, header.Filename, skill.PackageLimits{
		MaxFiles: config.SkillPackageMaxFiles, MaxFileBytes: config.SkillPackageMaxFileBytes,
		MaxTotalBytes: config.SkillPackageMaxTotalBytes, MaxCompressionRatio: 200,
	})
	if errors.Is(err, skill.ErrPackageLimitExceeded) {
		return skill.Package{}, agentregistry.ErrSkillPackageTooLarge
	}
	return pkg, err
}
