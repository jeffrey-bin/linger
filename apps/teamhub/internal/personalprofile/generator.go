package personalprofile

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

func supplementPrompt(input GenerationRequest) (system, user string) {
	system = UserProfileSystemPrompt(input.PromptVersion)
	var builder strings.Builder
	if input.SubjectDisplayName != "" {
		name, _ := json.Marshal(input.SubjectDisplayName)
		builder.WriteString("SUBJECT_DISPLAY_NAME ")
		builder.Write(name)
		builder.WriteString("\n\n")
	}
	if input.BaselineProfile != "" {
		builder.WriteString("BASELINE_PROFILE\n")
		builder.WriteString(input.BaselineProfile)
		builder.WriteString("\n\n")
	}
	for _, document := range input.Documents {
		builder.WriteString("SOURCE ")
		builder.WriteString(document.Filename)
		builder.WriteString("\n")
		builder.WriteString(document.Content)
		builder.WriteString("\n\n")
	}
	return system, builder.String()
}

// HTTPGenerator writes Personal Profiles through an Agent Service model call
// on the owner's Agent Runtime.
type HTTPGenerator struct {
	models  *roomagent.ModelCallClient
	timeout time.Duration
}

// NewHTTPGenerator bounds each Agent Service model call by timeout.
func NewHTTPGenerator(models *roomagent.ModelCallClient, timeout time.Duration) *HTTPGenerator {
	return &HTTPGenerator{models: models, timeout: timeout}
}

func (g *HTTPGenerator) Generate(ctx context.Context, input GenerationRequest) (GenerationResult, error) {
	system, user := supplementPrompt(input)
	return g.decodeSupplement(ctx, input, system, user)
}

func (g *HTTPGenerator) decodeSupplement(ctx context.Context, input GenerationRequest, system, user string) (GenerationResult, error) {
	schema := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []string{"profile", "account"},
		"properties": map[string]any{
			"profile": documentSchema(),
			"account": map[string]any{
				"type": "object", "additionalProperties": false,
				"required": []string{"name", "bio", "organization"},
				"properties": map[string]any{
					"name":         map[string]any{"type": "string"},
					"bio":          map[string]any{"type": "string"},
					"organization": map[string]any{"type": "string"},
				},
			},
		},
	}
	output, _, err := g.models.Structured(ctx, roomagent.ModelCallRequest{
		Kind: roomagent.KindProfile, Key: "profile:" + input.TenantID + ":" + input.OwnerActorID,
		Owner:        roomagent.ModelCallOwner{TenantID: input.TenantID, OwnerActorID: input.OwnerActorID},
		Instructions: system, Input: user, Timeout: g.timeout,
	}, "personal_profile_supplement", schema)
	if err != nil {
		return GenerationResult{}, errors.Join(ErrGeneratorUnavailable, err)
	}
	var raw struct {
		Profile Document `json:"profile"`
		Account struct {
			Name         string `json:"name"`
			Bio          string `json:"bio"`
			Organization string `json:"organization"`
		} `json:"account"`
	}
	if err := json.Unmarshal(output, &raw); err != nil {
		return GenerationResult{Error: "INVALID_PROFILE_OUTPUT"}, nil //nolint:nilerr // unparsable generator output is reported through GenerationResult.Error
	}
	raw.Profile.Background.Timeline = datedTimeline(raw.Profile.Background.Timeline)
	profile, err := NormalizeDocument(raw.Profile)
	if err != nil {
		return GenerationResult{Error: "INVALID_PROFILE_OUTPUT"}, nil //nolint:nilerr // an invalid generated document is reported through GenerationResult.Error
	}
	return GenerationResult{
		Profile: profile,
		Account: account.Fields{Name: strings.TrimSpace(raw.Account.Name), Bio: strings.TrimSpace(raw.Account.Bio), Organization: strings.TrimSpace(raw.Account.Organization)},
	}, nil
}

// datedTimeline keeps the timeline entries a Profile can publish. A source
// that names an experience without its period or organization gives an entry
// the document rule rejects; dropping it keeps the rest of the generated
// Profile, and the prompt puts such facts in Background's points instead.
func datedTimeline(entries []TimelineEntry) []TimelineEntry {
	kept := make([]TimelineEntry, 0, len(entries))
	for _, entry := range entries {
		if strings.TrimSpace(entry.Period) != "" && strings.TrimSpace(entry.Organization) != "" {
			kept = append(kept, entry)
		}
	}
	return kept
}
