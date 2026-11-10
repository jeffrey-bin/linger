package messagecreation

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type DocumentResource struct {
	Kind         string `json:"kind"`
	SegmentIndex int    `json:"segment_index"`
	Status       string `json:"status"`
	DocumentID   string `json:"document_id"`
	VersionID    string `json:"version_id,omitempty"`
	RevisionID   string `json:"revision_id,omitempty"`
	Name         string `json:"name"`
}

// CaptureDocumentResourcesTx snapshots authorized live reference heads as part
// of the original private-message receipt; replay never resolves a newer head.
func CaptureDocumentResourcesTx(ctx context.Context, tx pgx.Tx, tenantID string, segments []Segment) ([]DocumentResource, error) {
	result := []DocumentResource{}
	for index, segment := range segments {
		if segment.Type != "document" && segment.Type != "file" {
			continue
		}
		resource := DocumentResource{Kind: "document", SegmentIndex: index, Status: "reused", DocumentID: segment.DocumentID}
		err := tx.QueryRow(ctx, `SELECT d.title,coalesce(d.current_version_id,''),coalesce(snapshot_document_body(d.id),'') FROM documents d WHERE d.id=$1 AND d.tenant_id=$2 AND d.status='active' FOR SHARE OF d`, segment.DocumentID, tenantID).Scan(&resource.Name, &resource.VersionID, &resource.RevisionID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrInvalidDocument
		}
		if err != nil {
			return nil, err
		}
		if segment.Type == "file" {
			resource.VersionID = segment.DocumentVersionID
			resource.RevisionID = ""
		}
		if resource.VersionID == "" && resource.RevisionID == "" {
			return nil, ErrInvalidDocument
		}
		result = append(result, resource)
	}
	return result, nil
}
