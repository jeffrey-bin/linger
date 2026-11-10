package app

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func accountModel(id, email string, createdAt pgtype.Timestamptz) httpapi.Account {
	return httpapi.Account{Id: id, Email: openapi_types.Email(email), CreatedAt: createdAt.Time}
}

// tenantModel presents the deployment's Space. It is named after its Human
// and dates from the Account, so it has no row of its own.
func tenantModel(session store.GetActiveSessionRow) httpapi.Tenant {
	return httpapi.Tenant{
		Id: session.HumanTenantID, Name: session.HumanDisplayName + "'s Workspace",
		CreatedAt: session.AccountCreatedAt.Time,
	}
}

func (a *App) identity(ctx context.Context, session store.GetActiveSessionRow) (httpapi.CurrentIdentity, error) {
	actors, err := a.sessions.Actors(ctx, session.AccountID)
	if err != nil {
		return httpapi.CurrentIdentity{}, err
	}
	models := make([]httpapi.Actor, 0, len(actors))
	for _, actor := range actors {
		models = append(models, collaboration.ActorModel(actor))
	}
	return httpapi.CurrentIdentity{
		Account: accountModel(session.AccountID, session.Email, session.AccountCreatedAt),
		Actors:  models,
	}, nil
}

func (a *App) sessionModel(ctx context.Context, session store.GetActiveSessionRow) (httpapi.Session, error) {
	identity, err := a.identity(ctx, session)
	if err != nil {
		return httpapi.Session{}, err
	}
	return httpapi.Session{
		Id: session.ID, AccountId: session.AccountID, CreatedAt: session.CreatedAt.Time,
		ExpiresAt: session.ExpiresAt.Time, Identity: identity,
	}, nil
}

func textValue(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: value != ""}
}
