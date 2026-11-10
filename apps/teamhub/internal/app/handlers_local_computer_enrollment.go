package app

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

var (
	localComputerIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	localComputerPKCEPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	localComputerSecretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43,128}$`)
)

func (a *App) createLocalComputerEnrollment(c *gin.Context) {
	var request httpapi.LocalComputerEnrollmentCreateRequest
	if err := decodeJSON(c, &request); err != nil || !validLocalComputerEnrollmentCreate(request) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Local Computer enrollment request is invalid")
		return
	}
	tenantID := c.Param("tenantId")
	ownerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	if a.agentRuntimeState == nil || a.cfg.RunnerGatewayURL == "" {
		a.writeError(c, http.StatusServiceUnavailable, "COMPUTER_ENROLLMENT_UNAVAILABLE", "Local Computer enrollment is unavailable")
		return
	}
	renews := request.ComputerId != nil
	computerID := ids.New("computer")
	if renews {
		computerID = *request.ComputerId
	}
	enrollmentID, authorizationCode := ids.New("enrollment"), newLocalComputerAuthorizationCode()
	codeHash := sha256.Sum256([]byte(authorizationCode))
	expiresAt := time.Now().UTC().Add(localComputerEnrollmentLifetime)
	err := a.agentRuntimeState.CreateLocalComputerEnrollment(c.Request.Context(), agentruntimestate.CreateLocalComputerEnrollmentInput{
		EnrollmentID: enrollmentID, ComputerID: computerID, DisplayName: request.DisplayName,
		Owner:       agentruntimestate.LocalComputerOwner{TenantID: tenantID, OwnerActorID: ownerID},
		RedirectURI: request.RedirectUri, CodeChallenge: request.CodeChallenge,
		AuthorizationCodeHash: codeHash[:], ExpiresAt: expiresAt, RenewsExistingComputer: renews,
	})
	switch {
	case err == nil:
	case errors.Is(err, agentruntimestate.ErrRemoved):
		a.writeError(c, http.StatusGone, "LOCAL_COMPUTER_REMOVED", "Local Computer was removed")
		return
	case errors.Is(err, agentruntimestate.ErrNotFound), errors.Is(err, agentruntimestate.ErrConflict):
		a.writeError(c, http.StatusNotFound, "INVALID_ENROLLMENT", "Local Computer enrollment is invalid or expired")
		return
	case errors.Is(err, agentruntimestate.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Local Computer enrollment request is invalid")
		return
	default:
		a.internalError(c, "create Local Computer enrollment", err)
		return
	}
	c.JSON(http.StatusCreated, httpapi.LocalComputerEnrollmentAuthorization{
		EnrollmentId: enrollmentID, ComputerId: computerID,
		AuthorizationCode: &authorizationCode, ExpiresAt: expiresAt,
	})
}

func (a *App) listLocalComputers(c *gin.Context) {
	tenantID := c.Param("tenantId")
	ownerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	items, err := a.agents.ListOwnedLocalComputers(c.Request.Context(), tenantID, ownerID)
	if err != nil {
		a.internalError(c, "list Local Computers", err)
		return
	}
	c.JSON(http.StatusOK, httpapi.LocalComputerPage{Items: items})
}

func (a *App) removeLocalComputer(c *gin.Context) {
	tenantID, computerID := c.Param("tenantId"), c.Param("computerId")
	ownerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	if a.localComputers == nil {
		a.writeError(c, http.StatusServiceUnavailable, "LOCAL_COMPUTERS_UNAVAILABLE", "Local Computer management is unavailable")
		return
	}
	assignedAgents, err := a.agents.CountComputerAgents(c.Request.Context(), tenantID, computerID)
	if err != nil {
		a.logger.Error("check Local Computer assignments", "tenant_id", tenantID, "computer_id", computerID, "error", err)
		a.writeError(c, http.StatusServiceUnavailable, "LOCAL_COMPUTERS_UNAVAILABLE", "Local Computer management is unavailable")
		return
	}
	if assignedAgents > 0 {
		a.writeError(c, http.StatusConflict, "LOCAL_COMPUTER_HAS_AGENTS", "Remove this Computer's Agents before removing the Computer")
		return
	}
	err = a.localComputers.RemoveLocalComputer(c.Request.Context(), tenantID, ownerID, computerID)
	switch {
	case err == nil:
		c.Status(http.StatusNoContent)
	case errors.Is(err, roomagent.ErrLocalComputerNotFound):
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
	case errors.Is(err, roomagent.ErrLocalComputerHasAgents):
		a.writeError(c, http.StatusConflict, "LOCAL_COMPUTER_HAS_AGENTS", "Remove this Computer's Agents before removing the Computer")
	case errors.Is(err, roomagent.ErrLocalComputerBusy):
		a.writeError(c, http.StatusConflict, "LOCAL_COMPUTER_BUSY", "Wait for this Computer's active Operations before removing it")
	default:
		a.logger.Error("remove Local Computer", "tenant_id", tenantID, "owner_actor_id", ownerID, "computer_id", computerID, "error", err)
		a.writeError(c, http.StatusServiceUnavailable, "LOCAL_COMPUTERS_UNAVAILABLE", "Local Computer management is unavailable")
	}
}

func (a *App) exchangeLocalComputerEnrollment(c *gin.Context) {
	var request httpapi.LocalComputerEnrollmentExchangeRequest
	if err := decodeJSON(c, &request); err != nil || !validLocalComputerEnrollmentExchange(c.Param("enrollmentId"), request) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Local Computer enrollment request is invalid")
		return
	}
	if a.agentRuntimeState == nil || a.cfg.RunnerGatewayURL == "" {
		a.writeError(c, http.StatusServiceUnavailable, "COMPUTER_ENROLLMENT_UNAVAILABLE", "Local Computer enrollment is unavailable")
		return
	}
	codeHash := sha256.Sum256([]byte(*request.AuthorizationCode))
	challenge := sha256.Sum256([]byte(*request.CodeVerifier))
	result, err := a.agentRuntimeState.ConsumeLocalComputerEnrollment(c.Request.Context(), agentruntimestate.ConsumeLocalComputerEnrollmentInput{
		EnrollmentID: c.Param("enrollmentId"), RedirectURI: request.RedirectUri,
		CodeChallenge: base64.RawURLEncoding.EncodeToString(challenge[:]), AuthorizationCodeHash: codeHash[:],
	})
	if errors.Is(err, agentruntimestate.ErrInvalid) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Local Computer enrollment request is invalid")
		return
	}
	if err != nil {
		a.internalError(c, "exchange Local Computer enrollment", err)
		return
	}
	if !result.Available || result.Enrollment == nil || result.CredentialGeneration == nil {
		a.writeError(c, http.StatusNotFound, "INVALID_ENROLLMENT", "Local Computer enrollment is invalid or expired")
		return
	}
	issuedAt := time.Now().UTC()
	expiresAt := issuedAt.Add(runnerCredentialLifetime)
	owner := result.Enrollment.Owner
	token, err := signRunnerCredential(a.cfg.RunnerSigningKey, runnerCredentialClaims{
		CredentialGeneration: *result.CredentialGeneration, Exp: expiresAt.Unix(), Iat: issuedAt.Unix(),
		RunnerID:     result.Enrollment.ComputerID,
		TenantOwners: []runnerCredentialOwner{{OwnerActorID: owner.OwnerActorID, TenantID: owner.TenantID}}, V: 1,
	})
	if err != nil {
		a.internalError(c, "sign Local Computer credential", err)
		return
	}
	c.JSON(http.StatusOK, httpapi.LocalComputerCredentialBundle{
		ComputerId: result.Enrollment.ComputerID, TenantId: owner.TenantID, GatewayUrl: a.cfg.RunnerGatewayURL,
		GatewayToken: &token, CredentialExpiresAt: time.Unix(expiresAt.Unix(), 0).UTC(),
	})
}

func validLocalComputerEnrollmentCreate(request httpapi.LocalComputerEnrollmentCreateRequest) bool {
	return strings.TrimSpace(request.DisplayName) != "" && len(request.DisplayName) <= 120 &&
		(request.ComputerId == nil || localComputerIDPattern.MatchString(*request.ComputerId)) &&
		localComputerPKCEPattern.MatchString(request.CodeChallenge) && validLocalComputerRedirect(request.RedirectUri)
}

func newLocalComputerAuthorizationCode() string {
	value := make([]byte, 32)
	// crypto/rand.Read never returns an error since Go 1.24.
	_, _ = rand.Read(value)
	return base64.RawURLEncoding.EncodeToString(value)
}

func validLocalComputerEnrollmentExchange(enrollmentID string, request httpapi.LocalComputerEnrollmentExchangeRequest) bool {
	return localComputerIDPattern.MatchString(enrollmentID) &&
		request.AuthorizationCode != nil && localComputerSecretPattern.MatchString(*request.AuthorizationCode) &&
		request.CodeVerifier != nil && localComputerPKCEPattern.MatchString(*request.CodeVerifier) && validLocalComputerRedirect(request.RedirectUri)
}

func validLocalComputerRedirect(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.Path != "/callback" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.ForceQuery {
		return false
	}
	port := parsed.Port()
	if port == "" || parsed.Host != net.JoinHostPort("127.0.0.1", port) {
		return false
	}
	numericPort, err := strconv.Atoi(port)
	return err == nil && numericPort > 0 && numericPort <= 65535
}
