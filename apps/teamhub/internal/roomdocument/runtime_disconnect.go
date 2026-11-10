package roomdocument

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

const disconnectTimeout = 5 * time.Second

// Disconnect asks the Document Runtime to close the Document's collaboration
// connections, or only actorID's when it is not empty, after TeamHub committed
// a permission change. Each client reconnects with a token signed under the
// current permission count.
func (r *HTTPRuntime) Disconnect(ctx context.Context, documentID, actorID string) error {
	if !validDocumentSessionID(documentID) || (actorID != "" && !validDocumentSessionID(actorID)) {
		return ErrInvalidState
	}
	ctx, cancel := context.WithTimeout(ctx, disconnectTimeout)
	defer cancel()
	var request nodeservicesinternal.DisconnectDocumentConnectionsRequest
	if actorID != "" {
		request.ActorId = &actorID
	}
	response, err := r.client.DisconnectDocumentConnections(ctx, documentID, request)
	if err != nil {
		return fmt.Errorf("%w: disconnect Document connections: %w", ErrRuntimeUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return runtimeFailure(response)
	}
	return nil
}
