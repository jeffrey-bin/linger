package document

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

const maxWikiCandidateResponseBytes = 256 << 20

// wikiComputerOfflineCode is the LLM Wiki error code for a generation whose
// owner's Computer is offline.
const wikiComputerOfflineCode = "WIKI_COMPUTER_OFFLINE"

// wikiServiceStoppingCode is the LLM Wiki error code for a generation its
// restarting process stopped.
const wikiServiceStoppingCode = "WIKI_SERVICE_STOPPING"

var wikiCandidateIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

type HTTPWikiCandidateGenerator struct {
	client       nodeservicesinternal.ClientInterface
	serviceToken string
}

// NewHTTPWikiCandidateGenerator calls the LLM Wiki role at the Node Services
// base URL.
func NewHTTPWikiCandidateGenerator(
	baseURL, serviceToken string,
	client *http.Client,
) (*HTTPWikiCandidateGenerator, error) {
	serviceURL, err := wikiCandidateServiceURL(baseURL)
	if err != nil {
		return nil, err
	}
	if serviceToken == "" || len(serviceToken) > 4096 || strings.ContainsAny(serviceToken, " \t\r\n,") {
		return nil, errors.New("LLM Wiki candidate service token is invalid")
	}
	if client == nil {
		client = &http.Client{}
	}
	generated, err := nodeservicesinternal.NewClient(serviceURL, nodeservicesinternal.WithHTTPClient(client))
	if err != nil {
		return nil, fmt.Errorf("create LLM Wiki candidate client: %w", err)
	}
	return &HTTPWikiCandidateGenerator{client: generated, serviceToken: serviceToken}, nil
}

// GenerateWikiCandidates streams each frozen body into the request as it is
// written, so one refresh never holds every source in memory.
func (g *HTTPWikiCandidateGenerator) GenerateWikiCandidates(
	ctx context.Context,
	request WikiCandidateGenerationRequest,
) (WikiCandidateGenerationResult, error) {
	if err := validateWikiCandidateGenerationRequest(request); err != nil {
		return WikiCandidateGenerationResult{}, err
	}
	probe := &wikiRequestWriter{probe: true}
	if err := writeWikiCandidateRequest(ctx, probe, request); err != nil {
		return WikiCandidateGenerationResult{}, err
	}
	if probe.count > maxWikiCandidateRequestBytes {
		return WikiCandidateGenerationResult{}, fmt.Errorf("%w: encoded Wiki candidate request exceeds %d bytes", ErrWikiCandidateInvalidRequest, maxWikiCandidateRequestBytes)
	}
	reader, writer := io.Pipe()
	streamCtx, cancelStream := context.WithCancel(ctx)
	defer cancelStream()
	finished := make(chan error, 1)
	go func() {
		err := writeWikiCandidateRequest(streamCtx, &wikiRequestWriter{writer: writer}, request)
		_ = writer.CloseWithError(err)
		finished <- err
	}()
	response, err := g.client.GenerateWikiRefreshCandidatesWithBody(
		ctx, request.RefreshID, "application/json", reader,
		func(_ context.Context, httpRequest *http.Request) error {
			httpRequest.ContentLength = probe.count
			if request.SavePreview != nil {
				httpRequest.Header.Set("Accept", "application/x-ndjson")
			} else {
				httpRequest.Header.Set("Accept", "application/json")
			}
			httpRequest.Header.Set("Authorization", "Bearer "+g.serviceToken)
			return nil
		},
	)
	_ = reader.Close()
	cancelStream()
	streamErr := <-finished
	if streamErr != nil && err != nil {
		return WikiCandidateGenerationResult{}, errors.Join(ErrRuntimeUnavailable, err, streamErr)
	}
	if streamErr != nil && response != nil && response.StatusCode == http.StatusOK {
		_ = response.Body.Close()
		return WikiCandidateGenerationResult{}, errors.Join(ErrRuntimeUnavailable, streamErr)
	}
	if streamErr != nil && !errors.Is(streamErr, io.ErrClosedPipe) && !errors.Is(streamErr, context.Canceled) {
		if response != nil {
			_ = response.Body.Close()
		}
		return WikiCandidateGenerationResult{}, errors.Join(ErrRuntimeUnavailable, streamErr)
	}
	if err != nil {
		return WikiCandidateGenerationResult{}, fmt.Errorf("%w: request Wiki candidates: %w", ErrRuntimeUnavailable, err)
	}
	defer response.Body.Close()
	var body []byte
	if response.StatusCode == http.StatusOK && response.Header.Get("Content-Type") == "application/x-ndjson" && request.SavePreview != nil {
		var status int
		status, body, err = readWikiPreviewStream(response.Body, request.SavePreview)
		if err != nil {
			return WikiCandidateGenerationResult{}, err
		}
		response.StatusCode = status
		response.Header.Set("Content-Type", "application/json")
	} else {
		body, err = io.ReadAll(io.LimitReader(response.Body, maxWikiCandidateResponseBytes+1))
	}
	if err != nil {
		return WikiCandidateGenerationResult{}, fmt.Errorf("%w: read Wiki candidate response: %w", ErrRuntimeUnavailable, err)
	}
	if len(body) > maxWikiCandidateResponseBytes {
		return WikiCandidateGenerationResult{}, fmt.Errorf("%w: Wiki candidate response exceeds %d bytes", ErrRuntimeUnavailable, maxWikiCandidateResponseBytes)
	}
	contentType := response.Header.Get("Content-Type")
	if response.StatusCode != http.StatusOK && strings.HasPrefix(strings.ToLower(contentType), "application/json") {
		var failure nodeservicesinternal.WikiRefreshCandidateErrorResponse
		decodeErr := json.Unmarshal(body, &failure)
		if decodeErr == nil && failure.Error.Code == wikiComputerOfflineCode {
			return WikiCandidateGenerationResult{}, fmt.Errorf("%w: Wiki candidate response status=%d", ErrWikiCandidateComputerOffline, response.StatusCode)
		}
		if decodeErr == nil && failure.Error.Code == wikiServiceStoppingCode {
			return WikiCandidateGenerationResult{}, fmt.Errorf("%w: Wiki candidate response status=%d", ErrWikiCandidateServiceStopping, response.StatusCode)
		}
		if decodeErr == nil && failure.Error.Disposition == nodeservicesinternal.Terminal {
			// Do not include the remote message: it may contain provider/source data.
			sentinel := ErrWikiCandidateTerminal
			if response.StatusCode == http.StatusBadRequest || response.StatusCode == http.StatusRequestEntityTooLarge {
				sentinel = ErrWikiCandidateInvalidRequest
			}
			return WikiCandidateGenerationResult{}, fmt.Errorf("%w: Wiki candidate response status=%d", sentinel, response.StatusCode)
		}
	}
	if response.StatusCode != http.StatusOK ||
		!strings.HasPrefix(strings.ToLower(contentType), "application/json") {
		return WikiCandidateGenerationResult{}, fmt.Errorf(
			"%w: Wiki candidate response status=%d content_type=%q",
			ErrRuntimeUnavailable, response.StatusCode, contentType,
		)
	}
	var decoded nodeservicesinternal.WikiRefreshCandidateGenerationResult
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return WikiCandidateGenerationResult{}, fmt.Errorf("%w: decode Wiki candidate response: %w", ErrRuntimeUnavailable, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return WikiCandidateGenerationResult{}, fmt.Errorf("%w: Wiki candidate response has trailing JSON", ErrRuntimeUnavailable)
	}
	if decoded.WikiRefreshId != request.RefreshID || len(decoded.Pages) < 1 || len(decoded.Pages) > maxWikiPages {
		return WikiCandidateGenerationResult{}, fmt.Errorf(
			"%w: invalid Wiki candidate envelope refresh_match=%t page_count=%d",
			ErrRuntimeUnavailable, decoded.WikiRefreshId == request.RefreshID, len(decoded.Pages),
		)
	}
	pages := make([]WikiPageCandidate, len(decoded.Pages))
	for i, page := range decoded.Pages {
		digest := sha256.Sum256(page.MarkdownContent)
		if page.MarkdownSha256 != hex.EncodeToString(digest[:]) {
			return WikiCandidateGenerationResult{}, fmt.Errorf(
				"%w: Wiki candidate page %q has a content hash mismatch",
				ErrRuntimeUnavailable, page.PageKey,
			)
		}
		pages[i] = WikiPageCandidate{PageKey: page.PageKey, Markdown: append([]byte(nil), page.MarkdownContent...)}
	}
	references := func(sources []nodeservicesinternal.WikiRefreshSourceReference) []WikiCandidateSourceReference {
		result := make([]WikiCandidateSourceReference, len(sources))
		for i, source := range sources {
			result[i] = WikiCandidateSourceReference{
				DocumentID: source.DocumentId, DocumentVersionID: source.DocumentVersionId, Filename: source.Filename,
			}
		}
		return result
	}
	return WikiCandidateGenerationResult{
		RefreshID: request.RefreshID, Pages: pages,
		Unsettled: references(decoded.UnsettledSources), Deferred: references(decoded.DeferredSources),
	}, nil
}

// readWikiPreviewStream delivers intermediate snapshots and requires a terminal response.
func readWikiPreviewStream(reader io.Reader, save func(map[string]string) error) (int, []byte, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64<<10), maxWikiCandidateResponseBytes+1)
	for scanner.Scan() {
		var frame struct {
			Kind   string
			Status int
			Body   json.RawMessage
			Pages  map[string]string
		}
		if err := json.Unmarshal(scanner.Bytes(), &frame); err != nil {
			return 0, nil, ErrRuntimeUnavailable
		}
		switch frame.Kind {
		case "preview":
			if frame.Pages == nil {
				return 0, nil, ErrRuntimeUnavailable
			}
			if err := save(frame.Pages); err != nil {
				return 0, nil, err
			}
		case "final":
			if frame.Status < 200 || frame.Status > 599 || len(frame.Body) == 0 {
				return 0, nil, ErrRuntimeUnavailable
			}
			return frame.Status, frame.Body, nil
		default:
			return 0, nil, ErrRuntimeUnavailable
		}
	}
	return 0, nil, errors.Join(ErrRuntimeUnavailable, scanner.Err())
}

func wikiFrozenSource(source WikiCandidateSource) nodeservicesinternal.WikiRefreshFrozenSource {
	frozen := nodeservicesinternal.WikiRefreshFrozenSource{
		Content:           nil,
		DocumentId:        source.DocumentID,
		DocumentVersionId: source.DocumentVersionID,
		Filename:          SafeSourceFilename(source.Filename),
		Sha256:            source.SHA256,
		SizeBytes:         source.SizeBytes,
	}
	if session := source.Session; session != nil {
		date, _ := time.Parse(time.DateOnly, session.Date)
		frozen.Session = &nodeservicesinternal.WikiRefreshSessionSource{
			Kind:                        nodeservicesinternal.WikiRefreshSessionSourceKind(session.Kind),
			Date:                        openapi_types.Date{Time: date},
			SessionId:                   session.SessionID,
			RoomId:                      session.RoomID,
			RepresentedHumanActorId:     session.RepresentedHumanActorID,
			RepresentedHumanDisplayName: session.RepresentedHumanDisplayName,
		}
		if session.TranscriptDocumentID != "" {
			frozen.Session.TranscriptDocumentId = &session.TranscriptDocumentID
			frozen.Session.TranscriptDocumentVersionId = &session.TranscriptDocumentVersionID
		}
	}
	return frozen
}

// validWikiCandidateSession checks the Session descriptor TeamHub sends.
func validWikiCandidateSession(session *WikiCandidateSession) bool {
	if session == nil {
		return true
	}
	if _, err := time.Parse(time.DateOnly, session.Date); err != nil {
		return false
	}
	transcript := session.TranscriptDocumentID != "" || session.TranscriptDocumentVersionID != ""
	return (session.Kind == "room" && !transcript || session.Kind == "recording" &&
		wikiCandidateIDPattern.MatchString(session.TranscriptDocumentID) &&
		wikiCandidateIDPattern.MatchString(session.TranscriptDocumentVersionID)) &&
		wikiCandidateIDPattern.MatchString(session.SessionID) &&
		wikiCandidateIDPattern.MatchString(session.RoomID) &&
		wikiCandidateIDPattern.MatchString(session.RepresentedHumanActorID) &&
		session.RepresentedHumanDisplayName != "" && len(session.RepresentedHumanDisplayName) <= 255
}

func validateWikiCandidateGenerationRequest(request WikiCandidateGenerationRequest) error {
	if !wikiCandidateIDPattern.MatchString(request.RefreshID) ||
		!wikiCandidateIDPattern.MatchString(request.TenantID) ||
		!wikiCandidateIDPattern.MatchString(request.GeneratorAgentActorID) ||
		(request.Mode != "initialize" && request.Mode != "update") ||
		len(request.BasePages) > maxWikiPages ||
		len(request.Changes.Added)+len(request.Changes.Modified)+len(request.Changes.Removed) < 1 ||
		len(request.Changes.Added)+len(request.Changes.Modified)+len(request.Changes.Removed) > maxWikiCandidateSourceChanges ||
		(request.Mode == "initialize" && (len(request.BasePages) != 0 || len(request.Changes.Added) == 0)) ||
		(request.Mode == "update" && len(request.BasePages) == 0) {
		return ErrInvalidInput
	}
	for _, page := range request.BasePages {
		digest := sha256.Sum256(page.Content)
		if !wikiPageKeyPattern.MatchString(page.PageKey) || page.SizeBytes < 0 || !validWikiDigest(page.SHA256) ||
			(page.loadContent == nil && (page.SizeBytes != int64(len(page.Content)) || page.SHA256 != hex.EncodeToString(digest[:]))) {
			return ErrInvalidInput
		}
	}
	documents := make(map[string]struct{})
	versions := make(map[string]struct{})
	for _, source := range append(append([]WikiCandidateSource{}, request.Changes.Added...), request.Changes.Modified...) {
		digest := sha256.Sum256(source.Content)
		if !wikiCandidateIDPattern.MatchString(source.DocumentID) ||
			!wikiCandidateIDPattern.MatchString(source.DocumentVersionID) ||
			source.Filename == "" ||
			source.SizeBytes < 0 || source.SizeBytes > 50<<20 ||
			!validWikiDigest(source.SHA256) || !validWikiCandidateSession(source.Session) ||
			(source.loadContent == nil && (source.SizeBytes != int64(len(source.Content)) || source.SHA256 != hex.EncodeToString(digest[:]))) {
			return ErrInvalidInput
		}
		if _, exists := documents[source.DocumentID]; exists {
			return ErrInvalidInput
		}
		documents[source.DocumentID] = struct{}{}
		// A Session's version is its text digest, which two Sessions with the
		// same text share; Document versions are unique.
		if source.Session != nil {
			continue
		}
		if _, exists := versions[source.DocumentVersionID]; exists {
			return ErrInvalidInput
		}
		versions[source.DocumentVersionID] = struct{}{}
	}
	for _, source := range request.Changes.Removed {
		if !wikiCandidateIDPattern.MatchString(source.DocumentID) || !wikiCandidateIDPattern.MatchString(source.DocumentVersionID) || source.Filename == "" {
			return ErrInvalidInput
		}
	}
	return nil
}

func validWikiDigest(value string) bool {
	digest, err := hex.DecodeString(value)
	return err == nil && len(digest) == sha256.Size && hex.EncodeToString(digest) == value
}

func wikiCandidateServiceURL(baseURL string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		strings.Trim(parsed.Path, "/") != "" {
		return "", errors.New("LLM Wiki URL must be an HTTP(S) service base URL")
	}
	parsed.Path = ""
	return parsed.String(), nil
}
