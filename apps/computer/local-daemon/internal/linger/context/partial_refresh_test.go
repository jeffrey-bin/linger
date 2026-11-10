package lingercontext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestProjectionRecoveryRemovesUncommittedReadonlyFiles(t *testing.T) {
	for _, restart := range []bool{false, true} {
		t.Run(fmt.Sprintf("restart=%t", restart), func(t *testing.T) {
			root := t.TempDir()
			databasePath := filepath.Join(root, "views.sqlite")
			viewsPath := filepath.Join(root, "views")
			content := []byte("no longer authorized")
			digest := sha256.Sum256(content)
			server := fileServer(t, nil, content)
			store, err := OpenViewStore(databasePath, viewsPath, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = store.Close() }()
			first, err := store.applyTestView(context.Background(), testView("a"), server.URL)
			if err != nil {
				t.Fatal(err)
			}
			blockedInbox := filepath.Join(first.WorkspacePath, "inbox")
			if err := os.WriteFile(blockedInbox, []byte("blocking fixture"), 0o600); err != nil {
				t.Fatal(err)
			}
			refresh := testView("b")
			input := FileInput{RelativePath: "b.txt", SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:])}
			refresh.Mappings = []Mapping{
				{Kind: "memory", TargetPath: "documents", Access: "read_only", Files: []FileInput{input}},
				{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only"},
			}
			if _, err := store.applyTestView(context.Background(), refresh, server.URL); err == nil {
				t.Fatal("partial publication failure was not injected")
			}
			staleFile := filepath.Join(first.WorkspacePath, "documents", "b.txt")
			if _, err := os.Stat(staleFile); err != nil {
				t.Fatalf("fixture did not publish B before failure: %v", err)
			}
			if restart {
				if err := store.Close(); err != nil {
					t.Fatal(err)
				}
				store, err = OpenViewStore(databasePath, viewsPath, server.Client())
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Remove(blockedInbox); err != nil {
				t.Fatal(err)
			}
			next := testView("c")
			if _, err := store.applyTestView(context.Background(), next, server.URL); err != nil {
				t.Fatal(err)
			}
			if _, err := store.CurrentView(context.Background(), next.ExecutionContextKey, next.ViewDigest); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(staleFile); !os.IsNotExist(err) {
				t.Fatal("C is ready but retains the uncommitted B document")
			}
		})
	}
}
