package document

import (
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestDocumentCommandsRejectInvalidInputBeforeDependencies(t *testing.T) {
	t.Parallel()

	emptyParent := ""
	testCases := map[string]func(*Service) error{
		"create missing account": func(service *Service) error {
			_, err := service.Create(t.Context(), CreateDocumentInput{})
			return err
		},
		"create empty parent": func(service *Service) error {
			_, err := service.Create(t.Context(), CreateDocumentInput{
				AccountID: "account-a", ParentID: &emptyParent,
			})
			return err
		},
		"metadata blank title": func(service *Service) error {
			_, err := service.UpdateMetadata(t.Context(), UpdateMetadataInput{
				AccountID: "account-a", DocumentID: "document-a", Title: "   ",
			})
			return err
		},
		"metadata long title": func(service *Service) error {
			_, err := service.UpdateMetadata(t.Context(), UpdateMetadataInput{
				AccountID: "account-a", DocumentID: "document-a", Title: strings.Repeat("t", 256),
			})
			return err
		},
		"draft title long title": func(service *Service) error {
			_, err := service.UpdateDraftTitle(t.Context(), UpdateDraftTitleInput{
				AccountID: "account-a", DocumentID: "document-a", Title: strings.Repeat("t", 256),
			})
			return err
		},
		"upload missing content": func(service *Service) error {
			_, err := service.Upload(t.Context(), UploadDocumentInput{
				AccountID: "account-a", IdempotencyKey: "upload-key", Filename: "file.txt",
				RepresentationFormat: "plain_text", MediaType: "text/plain",
			})
			return err
		},
		"context upload invalid target": func(service *Service) error {
			_, err := service.UploadToContext(t.Context(), UploadDocumentContextInput{
				UploadDocumentInput: UploadDocumentInput{
					AccountID: "account-a", IdempotencyKey: "upload-key", Filename: "file.txt",
					RepresentationFormat: "plain_text", MediaType: "text/plain", Content: strings.NewReader("content"),
				},
				Kind: "unknown", ContextID: "context-a",
			})
			return err
		},
		"version upload missing expected version": func(service *Service) error {
			_, err := service.UploadVersion(t.Context(), UploadDocumentVersionInput{
				AccountID: "account-a", DocumentID: "document-a", IdempotencyKey: "version-key",
				Filename: "file.txt", RepresentationFormat: "plain_text", MediaType: "text/plain",
				Content: strings.NewReader("content"),
			})
			return err
		},
	}

	for name, invoke := range testCases {

		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if err := invoke(&Service{}); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("command error = %v, want ErrInvalidInput", err)
			}
		})
	}
}

func TestValidAssetFilename(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		filename string
		want     bool
	}{
		{name: "ordinary", filename: "asset.bin", want: true},
		{name: "hidden", filename: ".env", want: true},
		{name: "exact rune limit", filename: strings.Repeat("€", 251) + ".bin", want: true},
		{name: "empty"},
		{name: "current directory", filename: "."},
		{name: "parent directory", filename: ".."},
		{name: "forward slash", filename: "bad/name"},
		{name: "backslash", filename: `bad\name`},
		{name: "nul", filename: "bad\x00name"},
		{name: "non NFC", filename: "e\u0301.png"},
		{name: "over rune limit", filename: strings.Repeat("€", 256)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := validAssetFilename(test.filename); got != test.want {
				t.Fatalf("validAssetFilename(%q)=%t want=%t", test.filename, got, test.want)
			}
		})
	}
}

func TestTreeWriteErrorNamesTakenFolder(t *testing.T) {
	err := treeWriteError(&pgconn.PgError{Code: "23505", ConstraintName: "document_placements_active_folder_name_key"})
	if !errors.Is(err, ErrFolderNameTaken) || !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate folder name = %v", err)
	}
	if err := treeWriteError(&pgconn.PgError{Code: "40001"}); errors.Is(err, ErrFolderNameTaken) || !errors.Is(err, ErrConflict) {
		t.Fatalf("serialization failure = %v", err)
	}
}
