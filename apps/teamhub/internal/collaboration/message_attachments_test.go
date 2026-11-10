package collaboration

import (
	"errors"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestMessageAttachmentCredentialNamesItsRoomUploaderAndExpiry(t *testing.T) {
	a := &Service{signingKey: []byte("attachment-test-key")}
	room := store.Room{ID: "room_a", TenantID: "tenant_a"}
	sign := func(credential messageAttachmentCredential) string {
		token, err := secretbox.Sign(a.signingKey, messageAttachmentUploadDomain, credential)
		if err != nil {
			t.Fatal(err)
		}
		if len(token) > secretbox.MaxSignedLength || !attachmentUploadTokenPattern.MatchString(token) {
			t.Fatalf("credential %q does not fit the request pattern", token)
		}
		return token
	}
	valid := messageAttachmentCredential{
		TenantID: "tenant_a", RoomID: "room_a", UploaderActorID: "actor_alice",
		Filename: "report.txt", MediaType: "text/plain", SizeBytes: 3,
		SHA256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", ObjectKey: "object_0123456789abcdef0123456789abcdef",
		CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().UTC().Add(messageAttachmentUploadTTL),
	}
	if got, ok := a.verifyMessageAttachmentCredential(sign(valid), room, "actor_alice"); !ok || got.ObjectKey != valid.ObjectKey {
		t.Fatalf("valid credential rejected: %+v %t", got, ok)
	}
	expired := valid
	expired.ExpiresAt = time.Now().Add(-time.Second)
	otherRoom := valid
	otherRoom.RoomID = "room_b"
	for name, token := range map[string]string{"expired": sign(expired), "other Room": sign(otherRoom)} {
		if _, ok := a.verifyMessageAttachmentCredential(token, room, "actor_alice"); ok {
			t.Errorf("%s credential verified", name)
		}
	}
	if _, ok := a.verifyMessageAttachmentCredential(sign(valid), room, "actor_bob"); ok {
		t.Error("another Human's credential verified")
	}
	other := &Service{signingKey: []byte("other-key")}
	if _, ok := other.verifyMessageAttachmentCredential(sign(valid), room, "actor_alice"); ok {
		t.Error("credential verified under another key")
	}
}

func TestKeepMessageAttachmentObjectAfterUploadTransaction(t *testing.T) {
	ordinaryFailure := errors.New("transaction rolled back before commit")
	unknownCommit := errors.Join(errMessageAttachmentCommitOutcomeUnknown, errors.New("connection lost during commit"))

	tests := []struct {
		name   string
		replay bool
		err    error
		want   bool
	}{
		{name: "committed upload", want: true},
		{name: "idempotent replay", replay: true, want: false},
		{name: "known failure", err: ordinaryFailure, want: false},
		{name: "unknown commit outcome", err: unknownCommit, want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := KeepMessageAttachmentObject(test.replay, test.err); got != test.want {
				t.Fatalf("KeepMessageAttachmentObject(%t, %v)=%t want=%t", test.replay, test.err, got, test.want)
			}
		})
	}
}

func TestMessageAttachmentMetadataNormalization(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		filename, mediaType, wantMediaType, wantFormat string
	}{
		{"brief.md", "text/x-markdown", "text/markdown", "markdown"},
		{"brief.markdown", "application/x-markdown; charset=utf-8", "text/markdown", "markdown"},
		{"page.html", "text/html", "text/html", "html"},
		{"notes.txt", "text/plain", "text/plain", "plain_text"},
	} {
		t.Run(test.filename+"/"+test.mediaType, func(t *testing.T) {
			t.Parallel()
			if got := NormalizeMessageAttachmentMediaType(test.filename, test.mediaType); got != test.wantMediaType {
				t.Fatalf("normalized media type=%q want=%q", got, test.wantMediaType)
			}
			if got := messageAttachmentRepresentationFormat(test.filename, test.mediaType); got != test.wantFormat {
				t.Fatalf("representation format=%q want=%q", got, test.wantFormat)
			}
		})
	}
}
