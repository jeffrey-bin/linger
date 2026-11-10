package messagecreation

import (
	"context"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// LockMessageMembers locks the Room memberships a Message's references and
// Skill segments will validate, before the caller locks any rooms row.
// Canonical order: memberships -> Contexts -> rooms -> Documents -> Accounts.
// NO KEY UPDATE blocks removal and runtime FOR SHARE locks but not the KEY
// SHARE that mention-target reads take. It performs no validation. It returns
// the Actors that have no membership row, which admission may create later.
func LockMessageMembers(ctx context.Context, queries *store.Queries, membershipRoomID string, actorIDs []string) ([]string, error) {
	ids := slices.Clone(actorIDs)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	missing := make([]string, 0)
	for _, actorID := range ids {
		if actorID == "" {
			continue
		}
		_, err := queries.GetRoomMemberForNoKeyUpdate(ctx, store.GetRoomMemberForNoKeyUpdateParams{
			RoomID: membershipRoomID, ActorID: actorID,
		})
		if !errors.Is(err, pgx.ErrNoRows) {
			if err != nil {
				return nil, err
			}
			continue
		}
		missing = append(missing, actorID)
	}
	return missing, nil
}
