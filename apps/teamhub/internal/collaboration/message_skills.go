package collaboration

import (
	"context"
	"encoding/json"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ErrInvalidMessageSkill reports a skill segment without an eligible Room Agent binding.
var ErrInvalidMessageSkill = messagecreation.ErrInvalidSkill

// validateMessageSkills checks skill segments in the collaboration Room before
// the Message admits any mentioned Actor: a skill belongs to an Agent that is
// already a member.
func validateMessageSkills(ctx context.Context, queries *store.Queries, tenantID, roomID string, content MessageContent) error {
	var segments []messagecreation.Segment
	if err := json.Unmarshal(content.encoded, &segments); err != nil {
		return err
	}
	return messagecreation.ValidateSkills(ctx, queries, tenantID, roomID, segments)
}

// messageMemberTargets lists the Actors named by reference and skill segments,
// the memberships that LockMessageMembers takes before any rooms row.
func messageMemberTargets(content MessageContent) ([]string, error) {
	targets := make([]string, 0)
	for _, segment := range content.segments {
		discriminator, err := segment.Discriminator()
		if err != nil {
			return nil, err
		}
		switch discriminator {
		case "reference":
			reference, err := segment.AsReferenceSegment()
			if err != nil {
				return nil, err
			}
			targets = append(targets, reference.Target)
		case "skill":
			skill, err := segment.AsSkillSegment()
			if err != nil {
				return nil, err
			}
			targets = append(targets, skill.Target)
		}
	}
	return targets, nil
}
