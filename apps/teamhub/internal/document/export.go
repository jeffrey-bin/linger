package document

import (
	"crypto/sha256"
	"encoding/hex"
	"slices"
)

type ExportAsset struct {
	ID, Filename, MediaType, SHA256 string
	SizeBytes                       int64
}

// ExportRuntimeRequest asks the Document Runtime to serialize one exact
// Revision state.
type ExportRuntimeRequest struct {
	RevisionID, RepresentationFormat              string
	StateBytes, StateVector                       []byte
	StateBytesSHA256, FullStateFingerprint        string
	StateHashVersion                              int
	AssetManifest                                 []ExportAsset
	CompleteAssetIDs, CompleteThreadIDs, Warnings []string
}

type ExportRuntimeResult struct {
	MediaType, SHA256                             string
	Bytes                                         []byte
	SizeBytes                                     int64
	CompleteAssetIDs, CompleteThreadIDs, Warnings []string
}

type exportPlan struct {
	TenantID, RevisionID                   string
	StateBytes, StateVector                []byte
	StateBytesSHA256, FullStateFingerprint string
	Assets                                 []ExportAsset
	CompleteThreadIDs                      []string
}

func validExportRuntimeResult(
	format string,
	assetIDs []string,
	threadIDs []string,
	result ExportRuntimeResult,
) bool {
	mediaType := map[string]string{"markdown": "text/markdown", "plain_text": "text/plain", "html": "text/html", "blocks": "application/json"}[format]
	if result.MediaType != mediaType || result.SizeBytes != int64(len(result.Bytes)) || result.SizeBytes < 0 ||
		result.CompleteAssetIDs == nil || result.CompleteThreadIDs == nil || result.Warnings == nil ||
		!slices.Equal(result.CompleteAssetIDs, assetIDs) ||
		!slices.Equal(result.CompleteThreadIDs, threadIDs) {
		return false
	}
	digest := sha256.Sum256(result.Bytes)
	return result.SHA256 == hex.EncodeToString(digest[:])
}
