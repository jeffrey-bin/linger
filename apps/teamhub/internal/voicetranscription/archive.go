// Package voicetranscription transcribes saved recording audio through Soniox
// for archive recovery.
package voicetranscription

import (
	"context"
	"errors"
)

var (
	ErrInvalidInput            = errors.New("invalid voice transcription input")
	ErrInvalidProviderResponse = errors.New("invalid voice transcription provider response")
	ErrProviderFailure         = errors.New("voice transcription provider failed")
	ErrProviderRateLimited     = errors.New("voice transcription provider rate limited")
	ErrProviderRejected        = errors.New("voice transcription provider rejected audio")
	ErrProviderTimeout         = errors.New("voice transcription provider timed out")
)

// ArchiveTranscriber accepts a bounded 16 kHz mono PCM block and requires the
// provider's final acknowledgement, including when the whole block is silence.
type ArchiveTranscriber interface {
	TranscribeArchivePCM(context.Context, []byte) ([]StreamingResult, error)
}

// StreamingResult is one final transcript segment of an archive block.
type StreamingResult struct {
	Text        string
	StartMS     int64
	EndMS       int64
	ProcessedMS int64
	Final       bool
	SpeakerID   string `json:",omitempty"`
	// Text offsets are UTF-8 bytes.
	Words []TimedWord `json:",omitempty"`
}

// TimedWord maps a complete provider word onto the original UTF-8 text.
// These fields are internal archive-recovery evidence, not a public contract.
type TimedWord struct {
	TextStart int
	TextEnd   int
	StartMS   int64
	EndMS     int64
}
