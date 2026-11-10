package composio

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"html"
	"strings"
)

type AppDocument struct {
	RemoteID string
	Filename string
	Markdown []byte
	// ProfileMarkdown is the document as the Profile reads it; for mail, the
	// whole message marked by author and kind.
	ProfileMarkdown []byte
	// Automated marks mail no person wrote: notifications, subscriptions and
	// marketing. The Profile budgets it after mail people wrote.
	Automated       bool
	InsightEvidence []byte
}

var ErrAppImportTooLarge = errors.New("App import content exceeded configured byte limits")

type AppImportLimits struct {
	MaxFieldBytes    int
	MaxDocumentBytes int
	MaxBatchBytes    int
}

func DefaultAppImportLimits() AppImportLimits {
	return AppImportLimits{MaxFieldBytes: 256 << 10, MaxDocumentBytes: 1 << 20, MaxBatchBytes: 10 << 20}
}

func NormalizeAppImportLimits(limits AppImportLimits) AppImportLimits {
	defaults := DefaultAppImportLimits()
	if limits.MaxFieldBytes <= 0 {
		limits.MaxFieldBytes = defaults.MaxFieldBytes
	}
	if limits.MaxDocumentBytes <= 0 {
		limits.MaxDocumentBytes = defaults.MaxDocumentBytes
	}
	if limits.MaxBatchBytes <= 0 {
		limits.MaxBatchBytes = defaults.MaxBatchBytes
	}
	return limits
}

type AppImportAccumulator struct {
	limits AppImportLimits
	total  int
}

func NewAppImportAccumulator(limits AppImportLimits) *AppImportAccumulator {
	return &AppImportAccumulator{limits: NormalizeAppImportLimits(limits)}
}

func (a *AppImportAccumulator) AddRecord(fields ...string) error {
	recordBytes := 0
	for _, field := range fields {
		if len(field) > a.limits.MaxFieldBytes {
			return ErrAppImportTooLarge
		}
		if recordBytes > a.limits.MaxDocumentBytes-len(field) {
			return ErrAppImportTooLarge
		}
		recordBytes += len(field)
	}
	if a.total > a.limits.MaxBatchBytes-recordBytes {
		return ErrAppImportTooLarge
	}
	a.total += recordBytes
	return nil
}

type appDocumentBuilder struct {
	content []byte
	limits  AppImportLimits
	total   *int
	err     error
}

func newAppDocumentBuilder(limits AppImportLimits, total *int) *appDocumentBuilder {
	return &appDocumentBuilder{limits: NormalizeAppImportLimits(limits), total: total}
}

func (b *appDocumentBuilder) Write(value []byte) (int, error) {
	if b.err != nil {
		return 0, b.err
	}
	if len(value) > b.limits.MaxDocumentBytes-len(b.content) || len(value) > b.limits.MaxBatchBytes-*b.total {
		b.err = ErrAppImportTooLarge
		return 0, b.err
	}
	b.content = append(b.content, value...)
	*b.total += len(value)
	return len(value), nil
}

func (b *appDocumentBuilder) WriteString(value string) (int, error) {
	return b.Write([]byte(value))
}

func (b *appDocumentBuilder) Content() ([]byte, error) {
	if b.err != nil {
		return nil, b.err
	}
	return append([]byte(nil), b.content...), nil
}

func safeAppText(value string) string {
	value = strings.ToValidUTF8(value, "[invalid UTF-8]")
	value = html.UnescapeString(value)
	value = strings.ReplaceAll(value, "\x00", "")
	return strings.TrimSpace(value)
}

func safeAppIdentifier(value string) string {
	var output strings.Builder
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_' {
			output.WriteRune(char)
		}
	}
	if output.Len() == 0 {
		return "source"
	}
	return output.String()
}

func boundedAppFilename(prefix, readableIdentity, stableIdentity, day string) string {
	const maxReadableBytes = 72
	readable := safeAppIdentifier(readableIdentity)
	if len(readable) > maxReadableBytes {
		readable = readable[:maxReadableBytes]
	}
	digest := sha256.Sum256([]byte(prefix + "\x00" + stableIdentity))
	return prefix + "-" + readable + "-" + hex.EncodeToString(digest[:8]) + "-" + day + ".md"
}
