package roomdocument

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"runtime"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestNativeExportDoesNotBufferEncodedState(t *testing.T) {
	state := bytes.Repeat([]byte{1}, 16<<20)
	digest := sha256.Sum256(state)
	hash := hex.EncodeToString(digest[:])
	var transmitted int64
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		var err error
		transmitted, err = io.Copy(io.Discard, request.Body)
		if err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: http.StatusServiceUnavailable, Body: io.NopCloser(strings.NewReader(`{}`)), Header: make(http.Header)}, nil
	})}
	rt, err := NewHTTPRuntime("http://runtime.invalid", "test-token", client)
	if err != nil {
		t.Fatal(err)
	}
	input := document.ExportRuntimeRequest{RevisionID: "revision_memory", RepresentationFormat: "markdown",
		AssetManifest: []document.ExportAsset{}, StateBytes: state, StateBytesSHA256: hash, StateVector: []byte{1},
		FullStateFingerprint: hash, StateHashVersion: 1, CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{}, Warnings: []string{}}
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, _ = rt.Export(t.Context(), input)
	runtime.ReadMemStats(&after)
	if transmitted < 21<<20 {
		t.Fatalf("missing state: transmitted=%d", transmitted)
	}
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 4<<20 {
		t.Fatalf("export encoding allocated %d bytes for 16MiB state; want at most 4MiB", allocated)
	}
}
