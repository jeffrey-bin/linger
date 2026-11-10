package roomdocument

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestHTTPRuntimeExportContract(t *testing.T) {
	exportBytes := []byte("Alpha\n\nBeta")
	exportDigest := sha256.Sum256(exportBytes)
	exportHash := hex.EncodeToString(exportDigest[:])
	stateBytes := []byte{1, 2, 3, 4}
	stateDigest := sha256.Sum256(stateBytes)
	stateHash := hex.EncodeToString(stateDigest[:])
	input := document.ExportRuntimeRequest{
		RevisionID: "document_revision_export_contract", RepresentationFormat: "markdown",
		StateBytes: stateBytes, StateBytesSHA256: stateHash, StateVector: []byte{1},
		FullStateFingerprint: stateHash, StateHashVersion: 1, AssetManifest: []document.ExportAsset{},
		CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{}, Warnings: []string{},
	}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/internal/v1/documents/export" ||
			request.Header.Get("Authorization") != "Bearer runtime-secret" {
			t.Fatalf("invalid Runtime export request: %s %s", request.Method, request.URL.String())
		}
		deadline, ok := request.Context().Deadline()
		if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > revisionExportTimeout {
			t.Fatalf("Runtime export deadline=%v ok=%v", deadline, ok)
		}
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload["revision_id"] != input.RevisionID || payload["format"] != input.RepresentationFormat {
			t.Fatalf("Runtime export payload=%+v", payload)
		}
		body := `{"media_type":"text/markdown","bytes":"` + base64.StdEncoding.EncodeToString(exportBytes) +
			`","size_bytes":11,"sha256":"` + exportHash +
			`","complete_references":{"document_asset_ids":[],"document_thread_ids":[]},"warnings":[]}`
		return &http.Response{
			StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)),
			Header: make(http.Header), Request: request,
		}, nil
	})}
	runtime, err := NewHTTPRuntime("https://runtime.example.test", "runtime-secret", client)
	if err != nil {
		t.Fatal(err)
	}

	result, err := runtime.Export(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if result.MediaType != "text/markdown" || result.SHA256 != exportHash ||
		result.SizeBytes != int64(len(exportBytes)) || string(result.Bytes) != string(exportBytes) {
		t.Fatalf("invalid Runtime Revision export result: %+v", result)
	}
}
