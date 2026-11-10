package composio

import (
	"context"
	"errors"
	"net/http"
)

// ContextSourceIdentity is the confirmed account behind a Google Drive connection.
type ContextSourceIdentity struct{ ID, Label string }

func (c *Client) IdentifyGoogleDrive(ctx context.Context, id string) (ContextSourceIdentity, error) {
	var wire struct {
		User struct {
			ID    string `json:"permissionId"`
			Email string `json:"emailAddress"`
		} `json:"user"`
	}
	err := c.proxy(ctx, proxyRequest{ConnectedAccountID: id, Endpoint: "https://www.googleapis.com/drive/v3/about", Method: http.MethodGet, Parameters: []proxyParameter{{Name: "fields", Value: "user(permissionId,emailAddress)", Type: "query"}}}, &wire, "identify Google Drive account")
	if err != nil {
		return ContextSourceIdentity{}, err
	}
	if wire.User.ID == "" || wire.User.Email == "" {
		return ContextSourceIdentity{}, errors.New("Google Drive identity response was incomplete")
	}
	return ContextSourceIdentity{wire.User.ID, wire.User.Email}, nil
}
