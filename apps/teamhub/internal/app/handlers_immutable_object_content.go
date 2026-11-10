package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

type immutableContentMetadata struct {
	Filename, MediaType string
}

type immutableObjectContent struct {
	filename  string
	mediaType string
	objectKey string
	sha256    string
	sizeBytes int64
}

func (a *App) writeImmutableObjectContent(c *gin.Context, content immutableObjectContent) {
	// Callers authorize before reaching here, so a revalidation hit never bypasses access checks.
	if matchesIfNoneMatch(c.GetHeader("If-None-Match"), `"`+content.sha256+`"`) {
		a.writeImmutableObjectContentHeaders(c, content)
		c.Writer.Header().Del("Content-Length")
		c.Status(http.StatusNotModified)
		return
	}
	a.writeImmutableObjectContentWithHeaders(c, content, a.writeImmutableObjectContentHeaders)
}

func (a *App) writeLatestObjectContent(c *gin.Context, content immutableObjectContent) {
	a.writeImmutableObjectContentWithHeaders(c, content, a.writeLatestObjectContentHeaders)
}

func (a *App) writeImmutableObjectContentWithHeaders(
	c *gin.Context,
	content immutableObjectContent,
	writeHeaders func(*gin.Context, immutableObjectContent),
) {
	writeHeaders(c, content)
	etag := `"` + content.sha256 + `"`
	requestedRange := strings.TrimSpace(c.GetHeader("Range"))
	ifRange := strings.TrimSpace(c.GetHeader("If-Range"))
	if requestedRange == "" || (ifRange != "" && ifRange != etag) {
		a.streamFullImmutableObjectContent(c, content)
		return
	}

	interval, err := parseArtifactByteRange(requestedRange, content.sizeBytes)
	if err != nil {
		c.Header("Content-Range", fmt.Sprintf("bytes */%d", content.sizeBytes))
		c.Header("Content-Length", "0")
		c.Status(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	length := interval.end - interval.start + 1
	file, err := a.openArtifactContentRange(c.Request.Context(), content.objectKey, interval.start, length)
	if a.writeArtifactOpenError(c, "open immutable object content range", err) {
		return
	}
	defer file.Close()
	c.Header("Content-Range", fmt.Sprintf("bytes %d-%d/%d", interval.start, interval.end, content.sizeBytes))
	c.Header("Content-Length", strconv.FormatInt(length, 10))
	c.Status(http.StatusPartialContent)
	if _, err := io.CopyN(c.Writer, file, length); err != nil && !errors.Is(err, context.Canceled) {
		a.logger.Error("stream immutable object content range", "error", err)
	}
}

func (a *App) streamFullImmutableObjectContent(c *gin.Context, content immutableObjectContent) {
	file, err := a.artifacts.Open(c.Request.Context(), content.objectKey)
	if a.writeArtifactOpenError(c, "open immutable object content", err) {
		return
	}
	defer file.Close()
	c.Header("Content-Length", strconv.FormatInt(content.sizeBytes, 10))
	c.Status(http.StatusOK)
	if _, err := io.Copy(c.Writer, file); err != nil && !errors.Is(err, context.Canceled) {
		a.logger.Error("stream immutable object content", "error", err)
	}
}

func (a *App) openArtifactContentRange(ctx context.Context, objectKey string, offset, length int64) (io.ReadCloser, error) {
	if ranged, ok := a.artifacts.(artifactstore.RangeObjectStore); ok {
		return ranged.OpenRange(ctx, objectKey, offset, length)
	}
	file, err := a.artifacts.Open(ctx, objectKey)
	if err != nil {
		return nil, err
	}
	if _, err := io.CopyN(io.Discard, file, offset); err != nil {
		_ = file.Close()
		return nil, err
	}
	return &artifactRangeReadCloser{Reader: io.LimitReader(file, length), closer: file}, nil
}

func (a *App) writeArtifactOpenError(c *gin.Context, operation string, err error) bool {
	if errors.Is(err, io.EOF) || errors.Is(err, artifactstore.ErrInvalidObjectKey) || errors.Is(err, context.Canceled) {
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "document content was not found")
		return true
	}
	if err != nil {
		a.internalError(c, operation, err)
		return true
	}
	return false
}

func (a *App) writeArtifactStorageError(c *gin.Context, err error) {
	if errors.Is(err, artifactstore.ErrTooLarge) {
		a.writeError(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "document content exceeds the configured limit")
		return
	}
	a.internalError(c, "store document content", err)
}

func (a *App) writeImmutableObjectContentHeaders(c *gin.Context, content immutableObjectContent) {
	c.Header("Accept-Ranges", "bytes")
	// Revalidate every use so logout or revoked access cannot be served from a shared browser cache.
	c.Header("Cache-Control", "private, no-cache")
	c.Header("ETag", `"`+content.sha256+`"`)
	c.Header("Content-Type", content.mediaType)
	c.Header("Content-Disposition", immutableContentDisposition(immutableContentMetadata{
		Filename: content.filename, MediaType: content.mediaType,
	}))
	c.Header("Content-Security-Policy", "sandbox; default-src 'none'")
	c.Header("Content-Length", strconv.FormatInt(content.sizeBytes, 10))
	c.Header("X-Content-Type-Options", "nosniff")
}

func (a *App) writeLatestObjectContentHeaders(c *gin.Context, content immutableObjectContent) {
	a.writeImmutableObjectContentHeaders(c, content)
	c.Header("X-Content-SHA256", content.sha256)
	c.Header("Cache-Control", "private, no-store")
}

var inlineImmutableMediaTypes = map[string]map[string]struct{}{
	".aac":  {"audio/aac": {}},
	".flac": {"audio/flac": {}, "audio/x-flac": {}},
	".m4a":  {"audio/mp4": {}, "audio/x-m4a": {}},
	".m4v":  {"video/mp4": {}},
	".mov":  {"video/quicktime": {}},
	".mp3":  {"audio/mpeg": {}},
	".mp4":  {"video/mp4": {}},
	".oga":  {"audio/ogg": {}},
	".ogg":  {"audio/ogg": {}, "video/ogg": {}},
	".ogv":  {"video/ogg": {}},
	".wav":  {"audio/wav": {}, "audio/x-wav": {}},
	".webm": {"audio/webm": {}, "video/webm": {}},
}

func immutableContentDisposition(record immutableContentMetadata) string {
	disposition := "attachment"
	extension := strings.ToLower(filepath.Ext(record.Filename))
	mediaType, _, err := mime.ParseMediaType(record.MediaType)
	if err == nil {
		if allowed, ok := inlineImmutableMediaTypes[extension]; ok {
			if _, ok := allowed[strings.ToLower(mediaType)]; ok {
				disposition = "inline"
			}
		}
	}
	formatted := mime.FormatMediaType(disposition, map[string]string{"filename": record.Filename})
	if formatted == "" {
		return disposition
	}
	return formatted
}

type artifactByteRange struct {
	start int64
	end   int64
}

func parseArtifactByteRange(header string, size int64) (artifactByteRange, error) {
	if size <= 0 || !strings.HasPrefix(header, "bytes=") || strings.Contains(header, ",") {
		return artifactByteRange{}, artifactstore.ErrInvalidRange
	}
	value := strings.TrimSpace(strings.TrimPrefix(header, "bytes="))
	startText, endText, found := strings.Cut(value, "-")
	if !found || strings.Contains(endText, "-") {
		return artifactByteRange{}, artifactstore.ErrInvalidRange
	}
	if startText == "" {
		suffix, err := parsePositiveRangeInteger(endText)
		if err != nil {
			return artifactByteRange{}, err
		}
		if suffix > size {
			suffix = size
		}
		return artifactByteRange{start: size - suffix, end: size - 1}, nil
	}
	start, err := parseRangeInteger(startText)
	if err != nil || start >= size {
		return artifactByteRange{}, artifactstore.ErrInvalidRange
	}
	end := size - 1
	if endText != "" {
		end, err = parseRangeInteger(endText)
		if err != nil || end < start {
			return artifactByteRange{}, artifactstore.ErrInvalidRange
		}
		if end >= size {
			end = size - 1
		}
	}
	return artifactByteRange{start: start, end: end}, nil
}

func parsePositiveRangeInteger(value string) (int64, error) {
	parsed, err := parseRangeInteger(value)
	if err != nil || parsed == 0 {
		return 0, artifactstore.ErrInvalidRange
	}
	return parsed, nil
}

func parseRangeInteger(value string) (int64, error) {
	if value == "" {
		return 0, artifactstore.ErrInvalidRange
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, artifactstore.ErrInvalidRange
		}
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, artifactstore.ErrInvalidRange
	}
	return parsed, nil
}

type artifactRangeReadCloser struct {
	io.Reader
	closer io.Closer
}

func (r *artifactRangeReadCloser) Close() error { return r.closer.Close() }
