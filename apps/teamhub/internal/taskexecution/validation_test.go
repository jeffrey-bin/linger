package taskexecution

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"testing"
)

func TestNormalizeRunSpecV1CanonicalizesDelegatedSpec(t *testing.T) {
	normalized, encoded, digest, err := NormalizeRunSpecV1(RunSpecV1{
		ResultAgentActorID: " actor_result ", AttemptPolicy: DelegatedAttemptPolicyV1(),
	})
	if err != nil {
		t.Fatalf("normalize run spec: %v", err)
	}
	if normalized.SchemaVersion != 1 || normalized.ResultAgentActorID != "actor_result" ||
		normalized.AttemptPolicy.TimeoutSeconds != 24*60*60 || normalized.AttemptPolicy.MaxRetries != 0 {
		t.Fatalf("unexpected normalized run spec: %+v", normalized)
	}
	wantDigest := sha256.Sum256(encoded)
	if !bytes.Equal(digest, wantDigest[:]) {
		t.Fatalf("spec hash=%x want=%x", digest, wantDigest)
	}
	var roundTrip RunSpecV1
	if err := json.Unmarshal(encoded, &roundTrip); err != nil || roundTrip.ResultAgentActorID != "actor_result" {
		t.Fatalf("canonical spec round trip=%+v err=%v", roundTrip, err)
	}
}

func TestNormalizeRunSpecV1RequiresAttemptPolicy(t *testing.T) {
	if _, _, _, err := NormalizeRunSpecV1(RunSpecV1{ResultAgentActorID: "actor_result"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("missing attempt policy error=%v want ErrInvalid", err)
	}
}

func TestNormalizeTurnMessageFreezesExecutableSnapshot(t *testing.T) {
	message, err := normalizeTurnMessage(TurnMessageInput{
		MessageID: " message_1 ", RawMessage: "Do the work",
		Segments: json.RawMessage(`[ { "content": "Do the work", "type": "text" } ]`),
		Author:   &TurnMessageAuthor{ActorID: " actor_alice ", Kind: "human", DisplayName: " Alice "},
	})
	if err != nil {
		t.Fatalf("normalize turn message: %v", err)
	}
	if message.MessageID != "message_1" || message.RawMessage != "Do the work" ||
		string(message.Segments) != `[{"content":"Do the work","type":"text"}]` || message.Author == nil ||
		message.Author.ActorID != "actor_alice" || message.Author.Kind != "human" || message.Author.DisplayName != "Alice" {
		t.Fatalf("unexpected message snapshot: %+v", message)
	}
}

func TestNormalizeTurnMessageRequiresTrustedPublicAuthor(t *testing.T) {
	base := TurnMessageInput{
		MessageID: "message_1", RawMessage: "Do the work",
		Segments: json.RawMessage(`[{"type":"text","content":"Do the work"}]`),
	}
	for _, author := range []*TurnMessageAuthor{
		nil,
		{ActorID: "", Kind: "human", DisplayName: "Alice"},
		{ActorID: "actor_alice", Kind: "system", DisplayName: "Alice"},
		{ActorID: "actor_alice", Kind: "human", DisplayName: ""},
	} {
		input := base
		input.Author = author
		if _, err := normalizeTurnMessage(input); err == nil {
			t.Fatalf("accepted invalid public author: %+v", author)
		}
	}
}
