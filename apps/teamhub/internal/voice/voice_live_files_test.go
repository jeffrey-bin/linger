package voice

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"testing"

	api "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

func TestVoiceTaskFileChunksRejectMissingOrInconsistentBoundaries(t *testing.T) {
	good := map[string]any{"data_base64": base64.StdEncoding.EncodeToString([]byte("hello")), "size": 5, "modified_ns": "1234567890123456789", "offset": 0, "next_offset": 5, "eof": true}
	chunk, err := decodeVoiceFileChunk(good)
	if err != nil || string(chunk.data) != "hello" {
		t.Fatalf("valid chunk=%v %v", chunk, err)
	}
	for key, value := range map[string]any{"modified_ns": "", "size": 4, "offset": -1, "next_offset": 9, "data_base64": "bad*", "eof": false} {
		bad := map[string]any{}
		for k, v := range good {
			bad[k] = v
		}
		bad[key] = value
		if _, err := decodeVoiceFileChunk(bad); err == nil {
			t.Fatalf("accepted inconsistent %s", key)
		}
	}
}

// fakeTaskFiles serves one task output file in chunks, optionally changing it
// after the first read.
type fakeTaskFiles struct {
	content  []byte
	chunk    int
	modified []string
	calls    int
}

func (f *fakeTaskFiles) CallLocalComputerTool(_ context.Context, call api.LocalComputerToolCall) (map[string]any, error) {
	offset := int(call.Arguments["offset"].(int64))
	end := min(offset+f.chunk, len(f.content))
	modified := f.modified[min(f.calls, len(f.modified)-1)]
	f.calls++
	return map[string]any{
		"data_base64": base64.StdEncoding.EncodeToString(f.content[offset:end]), "size": len(f.content),
		"modified_ns": modified, "offset": offset, "next_offset": end, "eof": end == len(f.content),
	}, nil
}

func TestCopyVoiceTaskFileReadsEveryChunkAndRefusesAChangingFile(t *testing.T) {
	files := &fakeTaskFiles{content: []byte("# ウォリアーズ brief\n116:113"), chunk: 7, modified: []string{"1"}}
	var out bytes.Buffer
	if err := copyVoiceTaskFile(t.Context(), files, api.LocalComputerToolCall{}, "report.md", &out); err != nil || out.String() != string(files.content) || files.calls < 2 {
		t.Fatalf("copy=%q calls=%d err=%v", out.String(), files.calls, err)
	}
	changing := &fakeTaskFiles{content: []byte("0123456789"), chunk: 4, modified: []string{"1", "2"}}
	if err := copyVoiceTaskFile(t.Context(), changing, api.LocalComputerToolCall{}, "report.md", io.Discard); err == nil {
		t.Fatal("a file that changed while read was accepted")
	}
}

func TestVoiceLiveMediaTypeIsABareType(t *testing.T) {
	for name, want := range map[string]string{"report.md": "text/markdown", "data.json": "application/json", "slides.pdf": "application/pdf", "blob": "application/octet-stream"} {
		if got := voiceLiveMediaType(name, ""); got != want {
			t.Errorf("%s: %s, want %s", name, got, want)
		}
	}
	if got := voiceLiveMediaType("x.md", "text/markdown; charset=utf-8"); got != "text/markdown" {
		t.Fatalf("stored type=%s", got)
	}
}

// A Document's file is named after its title, keeping the download's
// extension, whatever its stored filename is.
func TestVoiceLiveFileNameFollowsTheTitle(t *testing.T) {
	for _, tc := range []struct{ title, filename, want string }{
		{"Q3 plan", "latest.md", "Q3 plan.md"},
		{"deck.pptx", "deck.pptx", "deck.pptx"},
		{"Deck.PPTX", "upload.pptx", "Deck.PPTX"},
		{"a/b  notes", "latest.md", "a-b notes.md"},
		{" ", "report.pdf", "report.pdf"},
	} {
		if got := voiceLiveFileName(tc.title, tc.filename); got != tc.want {
			t.Errorf("voiceLiveFileName(%q, %q)=%q, want %q", tc.title, tc.filename, got, tc.want)
		}
	}
}
