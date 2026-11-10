package roomdocument

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"time"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

const revisionExportTimeout = 30 * time.Second

// Export renders one Document state. The state streams into the request body
// as base64, so a large state is never held twice in memory.
func (r *HTTPRuntime) Export(
	ctx context.Context,
	input document.ExportRuntimeRequest,
) (document.ExportRuntimeResult, error) {
	if !validExportRequest(input) {
		return document.ExportRuntimeResult{}, ErrInvalidState
	}
	ctx, cancel := context.WithTimeout(ctx, revisionExportTimeout)
	defer cancel()
	manifest := make([]nodeservicesinternal.ManifestEntry, len(input.AssetManifest))
	for index, entry := range input.AssetManifest {
		title := entry.Filename
		manifest[index] = nodeservicesinternal.ManifestEntry{
			Id: entry.ID, MediaType: entry.MediaType, SizeBytes: entry.SizeBytes,
			Sha256: entry.SHA256, Title: &title,
		}
	}
	payload := nodeservicesinternal.ExportDocumentRequest{
		RevisionId: input.RevisionID, SchemaVersion: input.StateHashVersion,
		State: nodeservicesinternal.ComputedDocumentState{
			StateBytes:  "",
			BytesSha256: input.StateBytesSHA256,
			StateVector: base64.StdEncoding.EncodeToString(input.StateVector),
			StateHash:   input.FullStateFingerprint, StateHashVersion: input.StateHashVersion,
			CompleteReferences: nodeservicesinternal.CompleteReferences{
				DocumentAssetIds:  input.CompleteAssetIDs,
				DocumentThreadIds: input.CompleteThreadIDs,
			},
			Warnings: input.Warnings,
		},
		AssetManifest: manifest,
		Format:        nodeservicesinternal.ExportDocumentRequestFormat(input.RepresentationFormat),
	}
	metadata, err := json.Marshal(payload)
	if err != nil {
		return document.ExportRuntimeResult{}, err
	}
	prefix, suffix, found := bytes.Cut(metadata, []byte(`"state_bytes":""`))
	if !found {
		return document.ExportRuntimeResult{}, ErrInvalidState
	}
	reader, writer := io.Pipe()
	finished := make(chan error, 1)
	go func() {
		encoder := base64.NewEncoder(base64.StdEncoding, writer)
		_, writeErr := encoder.Write(input.StateBytes)
		streamErr := errors.Join(writeErr, encoder.Close())
		_ = writer.CloseWithError(streamErr)
		finished <- streamErr
	}()
	bodyReader := io.MultiReader(bytes.NewReader(prefix), bytes.NewReader([]byte(`"state_bytes":"`)), reader, bytes.NewReader([]byte(`"`)), bytes.NewReader(suffix))
	response, err := r.client.ExportDocumentWithBody(ctx, "application/json", bodyReader, func(_ context.Context, request *http.Request) error {
		request.ContentLength = int64(len(metadata) + base64.StdEncoding.EncodedLen(len(input.StateBytes)))
		return nil
	})
	_ = reader.Close()
	streamErr := <-finished
	if err != nil {
		return document.ExportRuntimeResult{}, fmt.Errorf("%w: call Document Runtime export: %w", ErrRuntimeUnavailable, errors.Join(err, streamErr))
	}
	if streamErr != nil && (response.StatusCode == http.StatusOK || !errors.Is(streamErr, io.ErrClosedPipe)) {
		_ = response.Body.Close()
		return document.ExportRuntimeResult{}, fmt.Errorf("%w: encode Document Runtime state: %w", ErrRuntimeUnavailable, streamErr)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return document.ExportRuntimeResult{}, runtimeFailure(response)
	}
	var result nodeservicesinternal.ExportDocumentResult
	if err := decodeRuntimeResponse(response.Body, &result); err != nil {
		return document.ExportRuntimeResult{}, err
	}
	return validateExportResult(input, result)
}

func validExportRequest(input document.ExportRuntimeRequest) bool {
	if !validDocumentSessionID(input.RevisionID) ||
		(input.RepresentationFormat != "markdown" && input.RepresentationFormat != "plain_text" &&
			input.RepresentationFormat != "html" && input.RepresentationFormat != "blocks") ||
		len(input.StateBytes) > 32<<20 || len(input.StateVector) > 1<<20 ||
		input.StateHashVersion != 1 || !sha256Pattern.MatchString(input.StateBytesSHA256) ||
		!sha256Pattern.MatchString(input.FullStateFingerprint) || input.CompleteAssetIDs == nil ||
		input.CompleteThreadIDs == nil || input.Warnings == nil ||
		!validReferenceIDs(input.CompleteAssetIDs) || !validReferenceIDs(input.CompleteThreadIDs) ||
		len(input.CompleteAssetIDs)+len(input.CompleteThreadIDs) > 4096 ||
		len(input.AssetManifest) != len(input.CompleteAssetIDs) || len(input.Warnings) > 256 ||
		bytesHash(input.StateBytes) != input.StateBytesSHA256 {
		return false
	}
	for index, warning := range input.Warnings {
		if !utf8.ValidString(warning) || utf8.RuneCountInString(warning) > 1024 {
			return false
		}
		if index > 0 && input.Warnings[index-1] == warning {
			return false
		}
	}
	for index, entry := range input.AssetManifest {
		if !validDocumentSessionID(entry.ID) || entry.ID != input.CompleteAssetIDs[index] ||
			entry.MediaType == "" || len(entry.MediaType) > 255 || entry.SizeBytes < 0 ||
			!sha256Pattern.MatchString(entry.SHA256) || utf8.RuneCountInString(entry.Filename) > 1024 {
			return false
		}
	}
	return true
}

func validReferenceIDs(ids []string) bool {
	return len(ids) <= 4096 && uniqueDocumentIDs(ids) && slices.IsSorted(ids)
}

func validateExportResult(
	input document.ExportRuntimeRequest,
	result nodeservicesinternal.ExportDocumentResult,
) (document.ExportRuntimeResult, error) {
	decoded, err := decodeCanonicalBase64(result.Bytes)
	if err != nil || len(decoded) > 32<<20 || result.SizeBytes != int64(len(decoded)) || result.SizeBytes < 0 ||
		!sha256Pattern.MatchString(result.Sha256) || result.CompleteReferences.DocumentAssetIds == nil ||
		result.CompleteReferences.DocumentThreadIds == nil || result.Warnings == nil ||
		!slices.Equal(result.CompleteReferences.DocumentAssetIds, input.CompleteAssetIDs) ||
		!slices.Equal(result.CompleteReferences.DocumentThreadIds, input.CompleteThreadIDs) ||
		len(result.Warnings) > 256 || string(result.MediaType) != exportMediaType(input.RepresentationFormat) ||
		bytesHash(decoded) != result.Sha256 {
		return document.ExportRuntimeResult{}, ErrInvalidState
	}
	for _, warning := range result.Warnings {
		if !utf8.ValidString(warning) || utf8.RuneCountInString(warning) > 1024 {
			return document.ExportRuntimeResult{}, ErrInvalidState
		}
	}
	return document.ExportRuntimeResult{
		MediaType: string(result.MediaType), Bytes: decoded, SizeBytes: result.SizeBytes,
		SHA256:            result.Sha256,
		CompleteAssetIDs:  append([]string{}, result.CompleteReferences.DocumentAssetIds...),
		CompleteThreadIDs: append([]string{}, result.CompleteReferences.DocumentThreadIds...),
		Warnings:          append([]string{}, result.Warnings...),
	}, nil
}

func decodeCanonicalBase64(value string) ([]byte, error) {
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || base64.StdEncoding.EncodeToString(decoded) != value {
		return nil, ErrInvalidState
	}
	return decoded, nil
}

func exportMediaType(format string) string {
	switch format {
	case "markdown":
		return "text/markdown"
	case "plain_text":
		return "text/plain"
	case "html":
		return "text/html"
	case "blocks":
		return "application/json"
	default:
		return ""
	}
}
