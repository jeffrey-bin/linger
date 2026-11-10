package collaboration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// ErrRoomNameTaken reports a name already used by a Room the Human is in.
var ErrRoomNameTaken = errors.New("room name is already in use")

// CreateRoom creates a Room of the Human, with optional first members, idempotently.
func (s *Service) CreateRoom(ctx context.Context, accountID, tenantID string, request httpapi.HumanRoomCreateRequest, key string, memberActorIDs ...string) (idempotency.Result, error) {
	operation := "createRoom:" + tenantID
	requestHash := idempotency.HashRequest(request)
	if len(memberActorIDs) > 0 {
		requestHash = idempotency.HashRequest(struct {
			Room    httpapi.HumanRoomCreateRequest
			Members []string
		}{request, memberActorIDs})
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return idempotency.Result{}, err
	}
	defer tx.Rollback(ctx)
	if err := idempotency.Lock(ctx, tx, idempotency.AccountKey(accountID, operation, key)); err != nil {
		return idempotency.Result{}, err
	}
	queries := s.queries.WithTx(tx)
	actor, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: tenantID, AccountID: textValue(accountID)})
	if err != nil {
		return idempotency.Result{}, err
	}
	if replay, found, err := idempotency.Replay(ctx, tx, idempotency.AccountKey(accountID, operation, key), requestHash); err != nil {
		return idempotency.Result{}, err
	} else if found {
		return replay, tx.Commit(ctx)
	}
	// Names are unique among the Rooms this Human is actually in. A Room they
	// are not a member of is invisible to them, so blocking the name over it
	// would reject a name nothing in their own list explains. Serialize per
	// creator, since two Humans may now hold the same name.
	normalizedName := strings.ToLower(strings.TrimSpace(request.Name))
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "room-name:"+tenantID+":"+actor.ID+":"+normalizedName); err != nil {
		return idempotency.Result{}, err
	}
	nameTaken, err := queries.HumanRoomNameTaken(ctx, store.HumanRoomNameTakenParams{
		TenantID: tenantID, NormalizedName: normalizedName, ActorID: actor.ID,
	})
	if err != nil {
		return idempotency.Result{}, err
	}
	if nameTaken {
		return idempotency.Result{}, ErrRoomNameTaken
	}
	created, err := roomcreation.Create(ctx, queries, roomcreation.Spec{
		TenantID: tenantID, Name: request.Name, Description: request.Description,
		Creator: actor, Owner: actor, MemberActorIDs: memberActorIDs, AgentsAuthorized: true,
	})
	if err != nil {
		return idempotency.Result{}, err
	}
	model := roomModel(created.Room, created.Creator)
	body, err := json.Marshal(model)
	if err != nil {
		return idempotency.Result{}, err
	}
	if err := idempotency.Save(ctx, tx, idempotency.AccountKey(accountID, operation, key), requestHash, idempotency.Record{ResourceID: created.Room.ID, Status: http.StatusCreated, Body: body}); err != nil {
		return idempotency.Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return idempotency.Result{}, err
	}
	return idempotency.Result{Status: http.StatusCreated, Body: body}, nil
}

func lastRoomID(items []store.ListRoomsForTenantAccountRow) string {
	if len(items) == 0 {
		return ""
	}
	return items[len(items)-1].ID
}
