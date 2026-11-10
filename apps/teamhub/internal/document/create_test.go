package document

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestValidBlankMaterialization(t *testing.T) {
	t.Parallel()

	stateBytes := []byte("blank-yjs-state")
	digest := sha256.Sum256(stateBytes)
	valid := ImportedState{
		StateBytes:           stateBytes,
		StateBytesSHA256:     hex.EncodeToString(digest[:]),
		FullStateFingerprint: hex.EncodeToString(digest[:]),
		StateHashVersion:     1,
	}
	if !validBlankMaterialization(valid) {
		t.Fatal("validBlankMaterialization() rejected a valid result")
	}

	testCases := map[string]func(ImportedState) ImportedState{
		"missing state": func(value ImportedState) ImportedState {
			value.StateBytes = nil
			return value
		},
		"wrong digest": func(value ImportedState) ImportedState {
			value.StateBytesSHA256 = value.FullStateFingerprint
			value.StateBytes = []byte("different")
			return value
		},
		"uppercase digest": func(value ImportedState) ImportedState {
			value.StateBytesSHA256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
			return value
		},
		"invalid fingerprint": func(value ImportedState) ImportedState {
			value.FullStateFingerprint = "not-a-sha256"
			return value
		},
		"unsupported hash version": func(value ImportedState) ImportedState {
			value.StateHashVersion = 0
			return value
		},
		"pre-completed asset": func(value ImportedState) ImportedState {
			value.CompleteAssetIDs = []string{"asset-a"}
			return value
		},
		"pre-completed thread": func(value ImportedState) ImportedState {
			value.CompleteThreadIDs = []string{"thread-a"}
			return value
		},
	}
	for name, mutate := range testCases {

		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if validBlankMaterialization(mutate(valid)) {
				t.Fatal("validBlankMaterialization() accepted an invalid result")
			}
		})
	}
}

func TestValidNativeMaterializationRequiresExactAssetReferences(t *testing.T) {
	t.Parallel()
	stateBytes := []byte("native-yjs-state")
	digest := sha256.Sum256(stateBytes)
	value := ImportedState{
		StateBytes: stateBytes, StateBytesSHA256: hex.EncodeToString(digest[:]),
		FullStateFingerprint: hex.EncodeToString(digest[:]), StateHashVersion: 1,
		CompleteAssetIDs: []string{"document_asset_a"}, CompleteThreadIDs: []string{},
	}
	if !validNativeMaterialization(value, []string{"document_asset_a"}) {
		t.Fatal("exact native Asset references were rejected")
	}
	if validNativeMaterialization(value, []string{}) || validNativeMaterialization(value, []string{"document_asset_b"}) {
		t.Fatal("non-exact native Asset references were accepted")
	}
}
