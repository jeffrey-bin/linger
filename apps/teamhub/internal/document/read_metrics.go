package document

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
)

// Only authorized native latest-content resolutions participate. Durable logs
// let a fixed-window analysis count repeated versions across replicas/restarts,
// without identity labels or another cache/table on the read path.
func observeLatestRead(ctx context.Context, reader, format, result, documentID, revisionID string) {
	if result != "hit" {
		return
	}
	documentKey := sha256.Sum256([]byte(documentID))
	revisionKey := sha256.Sum256([]byte(revisionID))
	slog.InfoContext(ctx, "document_latest_read", "event", "document_latest_read",
		"reader", reader, "format", format,
		"document_key", hex.EncodeToString(documentKey[:]),
		"revision_key", hex.EncodeToString(revisionKey[:]))
}
