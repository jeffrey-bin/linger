package agentregistry

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
)

func TestDecodeJSONObjectPreservesJSONNumbers(t *testing.T) {
	const precise = `{"type":"object","properties":{"count":{"const":9007199254740993}}}`
	decoded, err := decodeJSONObject([]byte(precise))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(encoded, []byte("9007199254740993")) {
		t.Fatalf("large JSON integer lost precision: %s", encoded)
	}
}

func TestKeepSkillPackageObjectsAfterRegistrationTransaction(t *testing.T) {
	ordinaryFailure := errors.New("transaction rolled back before commit")
	unknownCommit := errors.Join(errSkillCommitOutcomeUnknown, errors.New("connection lost during commit"))

	tests := []struct {
		name       string
		referenced bool
		err        error
		want       bool
	}{
		{name: "committed new package", referenced: true, want: true},
		{name: "equivalent package replay", want: false},
		{name: "known failure", referenced: true, err: ordinaryFailure, want: false},
		{name: "unknown commit outcome", referenced: true, err: unknownCommit, want: true},
		{name: "unknown replay commit outcome", err: unknownCommit, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := keepSkillPackageObjects(test.referenced, test.err); got != test.want {
				t.Fatalf("keepSkillPackageObjects(%t, %v)=%t want=%t", test.referenced, test.err, got, test.want)
			}
		})
	}
}

func TestWriteDeterministicSkillPackageZIP(t *testing.T) {
	files := []skill.PackageFile{
		{Path: "references/examples.md", Content: []byte("example\n")},
		{Path: "SKILL.md", Content: []byte("---\nname: sample\ndescription: Sample\n---\n")},
	}
	var first, second bytes.Buffer
	if err := writeSkillPackageZIP(&first, "sample", files); err != nil {
		t.Fatal(err)
	}
	if err := writeSkillPackageZIP(&second, "sample", files); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.Bytes(), second.Bytes()) {
		t.Fatal("same logical package produced different ZIP bytes")
	}
	reader, err := zip.NewReader(bytes.NewReader(first.Bytes()), int64(first.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(reader.File) != 2 || reader.File[0].Name != "sample/SKILL.md" || reader.File[1].Name != "sample/references/examples.md" {
		t.Fatalf("unexpected deterministic ZIP order: %+v", reader.File)
	}
	for index, want := range [][]byte{files[1].Content, files[0].Content} {
		entry, err := reader.File[index].Open()
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(entry)
		_ = entry.Close()
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("ZIP entry %d content=%q err=%v", index, got, err)
		}
	}
}

// Private editor identities fit the legacy compatibility table and remain stable
// across retries, but cannot collide across Sponsors, Tenants or source Skills.
func TestPrivateEditedSkillIdentity(t *testing.T) {
	first := privateEditedSkillID("tenant", "sponsor", "shared")
	if first != privateEditedSkillID("tenant", "sponsor", "shared") || len(first) > 64 {
		t.Fatal(first)
	}
	for _, other := range []string{privateEditedSkillID("other", "sponsor", "shared"), privateEditedSkillID("tenant", "other", "shared"), privateEditedSkillID("tenant", "sponsor", "other")} {
		if first == other {
			t.Fatal("private identity collision")
		}
	}
}
