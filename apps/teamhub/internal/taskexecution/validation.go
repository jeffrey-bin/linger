package taskexecution

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"strings"
	"unicode/utf8"
)

const (
	maxRunSpecBytes      = 64 << 10
	maxTurnSegmentsBytes = 1 << 20
	maxParticipantLen    = 100
)

// NormalizeRunSpecV1 returns the canonical persisted representation and its SHA-256 hash.
func NormalizeRunSpecV1(input RunSpecV1) (RunSpecV1, []byte, []byte, error) {
	input.ResultAgentActorID = strings.TrimSpace(input.ResultAgentActorID)
	if input.SchemaVersion == 0 {
		input.SchemaVersion = 1
	}
	if input.SchemaVersion != 1 || input.ResultAgentActorID == "" || len(input.ResultAgentActorID) > 255 {
		return RunSpecV1{}, nil, nil, ErrInvalid
	}
	if input.AttemptPolicy.PolicyVersion != 1 || input.AttemptPolicy.MaxRetries < 0 || input.AttemptPolicy.MaxRetries > 10 ||
		input.AttemptPolicy.TimeoutSeconds < 1 || input.AttemptPolicy.TimeoutSeconds > 24*60*60 {
		return RunSpecV1{}, nil, nil, ErrInvalid
	}
	encoded, err := json.Marshal(input)
	if err != nil || len(encoded) > maxRunSpecBytes {
		return RunSpecV1{}, nil, nil, ErrInvalid
	}
	digest := sha256.Sum256(encoded)
	return input, encoded, digest[:], nil
}

func normalizeTurnMessage(input TurnMessageInput) (TurnMessageInput, error) {
	input.MessageID = strings.TrimSpace(input.MessageID)
	if input.Author == nil {
		return TurnMessageInput{}, ErrInvalid
	}
	author := *input.Author
	author.ActorID = strings.TrimSpace(author.ActorID)
	author.DisplayName = strings.TrimSpace(author.DisplayName)
	if input.MessageID == "" || len(input.MessageID) > 255 || strings.TrimSpace(input.RawMessage) == "" ||
		utf8.RuneCountInString(input.RawMessage) > 50000 || len(input.Segments) == 0 || len(input.Segments) > maxTurnSegmentsBytes ||
		author.ActorID == "" || len(author.ActorID) > 255 ||
		(author.Kind != "human" && author.Kind != "agent") || author.DisplayName == "" || utf8.RuneCountInString(author.DisplayName) > 120 {
		return TurnMessageInput{}, ErrInvalid
	}
	var segments []map[string]any
	decoder := json.NewDecoder(bytes.NewReader(input.Segments))
	decoder.UseNumber()
	if err := decoder.Decode(&segments); err != nil || len(segments) == 0 || len(segments) > 1000 {
		return TurnMessageInput{}, ErrInvalid
	}
	canonical, err := json.Marshal(segments)
	if err != nil {
		return TurnMessageInput{}, err
	}
	input.Segments = canonical
	input.Author = &author
	return input, nil
}
