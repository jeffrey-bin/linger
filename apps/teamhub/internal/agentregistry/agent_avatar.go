package agentregistry

import (
	"context"
	"encoding/base64"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const agentAvatarImageMaxLength = 131072

var agentAvatarImagePrefix = regexp.MustCompile(`^data:image/(?:jpeg|png|webp);base64,`)

// ValidAgentAvatarImage accepts the empty string (remove) or a bounded JPEG,
// PNG, or WebP base64 data URL.
func ValidAgentAvatarImage(value string) bool {
	if value == "" {
		return true
	}
	if len(value) > agentAvatarImageMaxLength {
		return false
	}
	prefix := agentAvatarImagePrefix.FindString(value)
	if prefix == "" {
		return false
	}
	payload := value[len(prefix):]
	if payload == "" {
		return false
	}
	_, err := base64.StdEncoding.DecodeString(payload)
	return err == nil
}

// UpdateTenantAgentAvatarTx replaces the avatar every Human sees for one Agent of the Sponsor.
func (s *Service) UpdateTenantAgentAvatarTx(
	ctx context.Context,
	accountID, tenantID, actorID string,
	request httpapi.TenantAgentAvatarUpdateRequest,
) (httpapi.TenantAgent, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	caller, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: tenantID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	row, err := queries.GetAgentRegistrationForUpdate(ctx, store.GetAgentRegistrationForUpdateParams{ActorID: actorID, TenantID: tenantID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	if row.Status == "revoked" {
		return httpapi.TenantAgent{}, pgx.ErrNoRows
	}
	// Only the Sponsor edits an Agent avatar.
	if row.CreatedByActorID != caller.ID {
		return httpapi.TenantAgent{}, collaboration.ErrAgentSponsorRequired
	}
	if err := queries.UpdateAgentRegistrationAvatarKey(ctx, store.UpdateAgentRegistrationAvatarKeyParams{
		AvatarKey: request.AvatarKey, ActorID: actorID, TenantID: tenantID,
	}); err != nil {
		return httpapi.TenantAgent{}, err
	}
	if request.AvatarImage != nil {
		if *request.AvatarImage == "" {
			err = queries.DeleteAgentAvatarImage(ctx, store.DeleteAgentAvatarImageParams{ActorID: actorID, TenantID: tenantID})
		} else {
			err = queries.UpsertAgentAvatarImage(ctx, store.UpsertAgentAvatarImageParams{
				ActorID: actorID, TenantID: tenantID, AvatarImage: *request.AvatarImage,
			})
		}
		if err != nil {
			return httpapi.TenantAgent{}, err
		}
	}
	actor, err := queries.GetActor(ctx, store.GetActorParams{ID: actorID, TenantID: tenantID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	creator, err := queries.GetActor(ctx, store.GetActorParams{ID: row.CreatedByActorID, TenantID: tenantID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	updated, err := queries.GetAgentRegistrationByActor(ctx, store.GetAgentRegistrationByActorParams{ActorID: actorID, TenantID: tenantID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	skills, err := listAgentRegistrationBindings(ctx, queries, []string{actorID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	images, err := AgentAvatarImageVersions(ctx, queries, tenantID, []string{actorID})
	if err != nil {
		return httpapi.TenantAgent{}, err
	}
	model := withAgentAvatarImage(
		tenantAgentModelWithBindings(actor, creator, agentRegistrationFromRow(updated), skills[actorID]),
		images,
	)
	// Profile edits wake the Tenant directory; the avatar is part of that profile.
	if err := createTenantDirectoryDeliveries(ctx, queries, tenantID); err != nil {
		return httpapi.TenantAgent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return httpapi.TenantAgent{}, err
	}
	return model, nil
}

// AgentAvatarImageVersions maps each Agent with an uploaded image to that
// image's version, without reading the image itself.
func AgentAvatarImageVersions(ctx context.Context, queries *store.Queries, tenantID string, actorIDs []string) (map[string]string, error) {
	versions := map[string]string{}
	if len(actorIDs) == 0 {
		return versions, nil
	}
	rows, err := queries.ListAgentAvatarImageVersions(ctx, store.ListAgentAvatarImageVersionsParams{TenantID: tenantID, ActorIds: actorIDs})
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		versions[row.ActorID] = agentAvatarImageVersion(row.UpdatedAt)
	}
	return versions, nil
}

// An image's version is its last write time; every upload moves it.
func agentAvatarImageVersion(updatedAt pgtype.Timestamptz) string {
	return strconv.FormatInt(updatedAt.Time.UnixMicro(), 36)
}

func agentAvatarImageURL(tenantID, actorID, version string) string {
	return "/v0/tenants/" + url.PathEscape(tenantID) + "/agents/" + url.PathEscape(actorID) +
		"/avatar-image?v=" + url.QueryEscape(version)
}

func withAgentAvatarImage(model httpapi.TenantAgent, versions map[string]string) httpapi.TenantAgent {
	actorID := model.Actor.Id
	if version, ok := versions[actorID]; ok {
		imageURL := agentAvatarImageURL(model.Actor.TenantId, actorID, version)
		model.AvatarImageUrl = &imageURL
	}
	return model
}

// decodeAgentAvatarImage splits a stored data URL into its media type and bytes.
func decodeAgentAvatarImage(value string) (string, []byte, bool) {
	prefix := agentAvatarImagePrefix.FindString(value)
	if prefix == "" {
		return "", nil, false
	}
	body, err := base64.StdEncoding.DecodeString(value[len(prefix):])
	if err != nil || len(body) == 0 {
		return "", nil, false
	}
	return strings.TrimSuffix(strings.TrimPrefix(prefix, "data:"), ";base64,"), body, true
}
