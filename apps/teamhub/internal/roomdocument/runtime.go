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
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

const maxDocumentRuntimeResponseBytes = 46 << 20

const importTimeout = 30 * time.Second

var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// HTTPRuntime calls the Document Runtime over its internal HTTP contract.
type HTTPRuntime struct {
	client *nodeservicesinternal.Client
}

// RuntimeError is a typed failure the Runtime reported.
type RuntimeError struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *RuntimeError) Error() string {
	return fmt.Sprintf("Document Runtime %s: %s", e.Code, e.Message)
}

// NewHTTPRuntime returns a Runtime client for the origin baseURL.
func NewHTTPRuntime(baseURL, token string, client *http.Client) (*HTTPRuntime, error) {
	trimmedURL := strings.TrimSpace(baseURL)
	if trimmedURL == "" || strings.TrimSpace(token) == "" {
		return nil, errors.New("Document Runtime URL and token are required")
	}
	parsed, err := url.Parse(trimmedURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("invalid Document Runtime URL %q", baseURL)
	}
	if client == nil {
		client = &http.Client{}
	}
	generated, err := nodeservicesinternal.NewClient(strings.TrimRight(trimmedURL, "/"),
		nodeservicesinternal.WithHTTPClient(client),
		nodeservicesinternal.WithRequestEditorFn(func(_ context.Context, request *http.Request) error {
			request.Header.Set("Authorization", "Bearer "+token)
			return nil
		}),
	)
	if err != nil {
		return nil, err
	}
	return &HTTPRuntime{client: generated}, nil
}

// Import computes the initial state of a new native Document.
func (r *HTTPRuntime) Import(ctx context.Context, input document.ImportRequest) (document.ImportedState, error) {
	if !validDocumentSessionID(input.OperationID) {
		return document.ImportedState{}, ErrInvalidState
	}
	ctx, cancel := context.WithTimeout(ctx, importTimeout)
	defer cancel()
	request := nodeservicesinternal.ImportDocumentRequest{
		OperationId:   input.OperationID,
		SchemaVersion: 1,
		SourceKind:    nodeservicesinternal.ImportDocumentRequestSourceKind(input.SourceKind),
	}
	if input.AllowedAssetIDs != nil {
		allowed := append([]string{}, input.AllowedAssetIDs...)
		request.AllowedDocumentAssetIds = &allowed
	}
	if input.AssetMappings != nil {
		mappings := make([]nodeservicesinternal.DocumentDuplicateAssetMapping, len(input.AssetMappings))
		for index, mapping := range input.AssetMappings {
			mappings[index] = nodeservicesinternal.DocumentDuplicateAssetMapping{
				SourceAssetId: mapping.SourceAssetID, TargetAssetId: mapping.TargetAssetID,
			}
		}
		request.AssetMappings = &mappings
	}
	if input.SourceKind != "blank" {
		encoded := base64.StdEncoding.EncodeToString(input.SourceBytes)
		request.SourceBytes = &encoded
	}
	response, err := r.client.ImportDocument(ctx, request)
	if err != nil {
		return document.ImportedState{}, fmt.Errorf("%w: call Document Runtime import: %w", ErrRuntimeUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return document.ImportedState{}, runtimeFailure(response)
	}
	var computed nodeservicesinternal.ComputedDocumentState
	if err := decodeRuntimeResponse(response.Body, &computed); err != nil {
		return document.ImportedState{}, err
	}
	return validateComputedState(computed)
}

// decodeRuntimeResponse strictly decodes one bounded JSON response.
func decodeRuntimeResponse(body io.Reader, target any) error {
	value, err := io.ReadAll(io.LimitReader(body, maxDocumentRuntimeResponseBytes+1))
	if err != nil {
		return fmt.Errorf("%w: read Document Runtime response: %w", ErrRuntimeUnavailable, err)
	}
	if len(value) > maxDocumentRuntimeResponseBytes || !utf8.Valid(value) {
		return ErrInvalidState
	}
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("%w: decode Document Runtime response: %w", ErrInvalidState, err)
	}
	if err := rejectTrailingJSON(decoder); err != nil {
		return fmt.Errorf("%w: decode Document Runtime response: %w", ErrInvalidState, err)
	}
	return nil
}

func rejectTrailingJSON(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func validateComputedState(computed nodeservicesinternal.ComputedDocumentState) (document.ImportedState, error) {
	if computed.CompleteReferences.DocumentAssetIds == nil ||
		computed.CompleteReferences.DocumentThreadIds == nil ||
		computed.Warnings == nil {
		return document.ImportedState{}, ErrInvalidState
	}
	stateBytes, err := base64.StdEncoding.Strict().DecodeString(computed.StateBytes)
	if err != nil || len(stateBytes) > 32<<20 {
		return document.ImportedState{}, ErrInvalidState
	}
	stateVector, err := base64.StdEncoding.Strict().DecodeString(computed.StateVector)
	if err != nil || len(stateVector) > 1<<20 {
		return document.ImportedState{}, ErrInvalidState
	}
	if bytesHash(stateBytes) != computed.BytesSha256 ||
		computed.StateHash != computed.BytesSha256 ||
		!sha256Pattern.MatchString(computed.StateHash) ||
		computed.StateHashVersion != 1 {
		return document.ImportedState{}, ErrInvalidState
	}
	return document.ImportedState{
		StateBytes: stateBytes, StateBytesSHA256: computed.BytesSha256,
		StateVector: stateVector, FullStateFingerprint: computed.StateHash,
		StateHashVersion:  computed.StateHashVersion,
		CompleteAssetIDs:  computed.CompleteReferences.DocumentAssetIds,
		CompleteThreadIDs: computed.CompleteReferences.DocumentThreadIds,
	}, nil
}

// runtimeFailure maps a Runtime failure response onto the Document service's
// errors and keeps the typed failure for its message: a rejected input is
// ErrInvalidInput, a missing Document ErrNotFound, anything else
// ErrRuntimeUnavailable.
func runtimeFailure(response *http.Response) error {
	failure := decodeRuntimeError(response)
	switch failure.Code {
	case "validation_failed", "invalid_request", "unsupported_document", "payload_too_large":
		return errors.Join(document.ErrInvalidInput, failure)
	case "not_found":
		return errors.Join(document.ErrNotFound, failure)
	}
	return errors.Join(ErrRuntimeUnavailable, failure)
}

// decodeRuntimeError reads the typed failure of a non-success response.
func decodeRuntimeError(response *http.Response) *RuntimeError {
	failure := &RuntimeError{Code: "invalid_response", Message: http.StatusText(response.StatusCode),
		Retryable: response.StatusCode >= 500 || response.StatusCode == http.StatusRequestTimeout ||
			response.StatusCode == http.StatusTooManyRequests}
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		return failure
	}
	var wire nodeservicesinternal.DocumentInternalError
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&wire) == nil && rejectTrailingJSON(decoder) == nil && wire.Code.Valid() && wire.Message != "" {
		return &RuntimeError{Code: string(wire.Code), Message: wire.Message, Retryable: wire.Retryable}
	}
	return failure
}
