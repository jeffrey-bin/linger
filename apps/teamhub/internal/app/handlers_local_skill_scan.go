package app

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const localSkillScanLifetime = 10 * time.Minute

func (a *App) scanLocalSkills(c *gin.Context) {
	var request httpapi.LocalSkillScanRequest
	if err := decodeJSON(c, &request); err != nil || !validLocalSkillRuntime(string(request.RuntimeType)) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Local Skill scan request is invalid")
		return
	}
	tenantID, computerID := c.Param("tenantId"), c.Param("computerId")
	ownerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	if a.localComputers == nil {
		a.writeError(c, http.StatusServiceUnavailable, "LOCAL_SKILL_SCAN_UNAVAILABLE", "Local Skill scanning is unavailable")
		return
	}
	// A scan only reads the Computer, so a retried request scans again and the
	// snapshot is never stored.
	scanID := idgen.New("local_skill_scan")
	result, err := a.localComputers.ScanLocalSkills(c.Request.Context(), roomagent.LocalSkillScanCommand{
		TenantID: tenantID, OwnerActorID: ownerID, ComputerID: computerID,
		CommandID: scanID, ScanID: scanID, RuntimeType: string(request.RuntimeType),
		ExpiresAt: time.Now().UTC().Add(localSkillScanLifetime),
	})
	if err != nil {
		a.writeLocalSkillGatewayError(c, "scan Local Skills", err)
		return
	}
	c.JSON(http.StatusOK, localSkillScanModel(result))
}

func localSkillScanModel(scan roomagent.LocalSkillScan) httpapi.LocalSkillScan {
	items := make([]httpapi.LocalSkillCandidate, 0, len(scan.Items))
	for _, item := range scan.Items {
		model := httpapi.LocalSkillCandidate{
			NativeSource: item.NativeSource, NativeEnabled: item.NativeEnabled,
			CandidateRef: item.CandidateRef, Name: item.Name, Description: item.Description,
			PackageSha256: item.PackageSHA256, FileCount: item.FileCount, SizeBytes: item.SizeBytes,
			Normalizations: append([]string(nil), item.Normalizations...), RiskFlags: append([]string(nil), item.RiskFlags...),
			Importability: httpapi.LocalSkillCandidateImportability(item.Importability),
		}
		if item.ErrorCode != "" {
			model.ErrorCode = &item.ErrorCode
		}
		if item.ErrorDetail != "" {
			model.ErrorDetail = &item.ErrorDetail
		}
		if item.ManifestExcerpt != "" {
			model.ManifestExcerpt = &item.ManifestExcerpt
		}
		items = append(items, model)
	}
	return httpapi.LocalSkillScan{
		ScanId: scan.ScanID, ComputerId: scan.ComputerID,
		RuntimeType: httpapi.LocalSkillScanRuntimeType(scan.RuntimeType), ExpiresAt: scan.ExpiresAt, Items: items,
	}
}

func validLocalSkillRuntime(runtimeType string) bool {
	return runtimeType == "codex" || runtimeType == "claude"
}

func (a *App) writeLocalSkillGatewayError(c *gin.Context, action string, err error) {
	switch {
	case errors.Is(err, roomagent.ErrLocalComputerNotFound):
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found or is offline")
	case errors.Is(err, roomagent.ErrLocalSkillCapabilityUnavailable):
		a.writeError(c, http.StatusConflict, "LOCAL_SKILL_CAPABILITY_UNAVAILABLE", "Upgrade the Local Computer before scanning Skills")
	default:
		a.logger.Error(action, "error", err)
		a.writeError(c, http.StatusServiceUnavailable, "LOCAL_SKILL_SERVICE_UNAVAILABLE", "Local Skill service is unavailable")
	}
}
