package lingercontext

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"sort"
	"strings"
)

var ErrProjectionRecoveryRequired = errors.New("Context projection recovery metadata is missing or invalid; preserve local files and restore a verified projection manifest before retrying")

type projectionFileVersion struct {
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"size_bytes"`
}

type projectionOwnership struct {
	ReadOnlyFiles map[string][]projectionFileVersion `json:"read_only_files"`
	ReadOnlyRoots []string                           `json:"read_only_roots"`
	WritableRoots []string                           `json:"writable_roots"`
}

// pendingProjection marks a publish in progress: the row claims every file
// the old and the new View project until the publish completes.
type pendingProjection struct {
	Ownership projectionOwnership `json:"ownership"`
}

func retainedProjectionOwnership(workspace string, record ViewRecord) (projectionOwnership, error) {
	ownership := projectionOwnership{ReadOnlyFiles: make(map[string][]projectionFileVersion)}
	if err := ownership.addMappings(workspace, record.View.Mappings); err != nil {
		return projectionOwnership{}, err
	}
	if record.Pending != nil {
		ownership.merge(record.Pending.Ownership)
	}
	return ownership, nil
}

func preparePendingProjection(workspace string, current ViewRecord, view View) (*pendingProjection, error) {
	ownership, err := retainedProjectionOwnership(workspace, current)
	if err != nil {
		return nil, err
	}
	if err := ownership.addMappings(workspace, view.Mappings); err != nil {
		return nil, err
	}
	return &pendingProjection{Ownership: ownership}, nil
}

func (ownership *projectionOwnership) addMappings(workspace string, mappings []Mapping) error {
	if ownership.ReadOnlyFiles == nil {
		ownership.ReadOnlyFiles = make(map[string][]projectionFileVersion)
	}
	for _, mapping := range mappings {
		root, err := safeJoin(workspace, mapping.TargetPath)
		if err != nil {
			return err
		}
		relativeRoot, err := filepath.Rel(workspace, root)
		if err != nil {
			return err
		}
		if mapping.Access == "read_write" {
			ownership.WritableRoots = appendUniquePath(ownership.WritableRoots, relativeRoot)
			continue
		}
		if mapping.Access != "read_only" {
			return ErrContextConflict
		}
		ownership.ReadOnlyRoots = appendUniquePath(ownership.ReadOnlyRoots, relativeRoot)
		for _, file := range mapping.Files {
			target, err := safeJoin(root, file.RelativePath)
			if err != nil {
				return err
			}
			relative, err := filepath.Rel(workspace, target)
			if err != nil {
				return err
			}
			ownership.addVersion(relative, projectionFileVersion{SHA256: file.SHA256, SizeBytes: file.SizeBytes})
		}
	}
	return nil
}

func (ownership *projectionOwnership) merge(other projectionOwnership) {
	for relative, versions := range other.ReadOnlyFiles {
		for _, version := range versions {
			ownership.addVersion(relative, version)
		}
	}
	for _, root := range other.ReadOnlyRoots {
		ownership.ReadOnlyRoots = appendUniquePath(ownership.ReadOnlyRoots, root)
	}
	for _, root := range other.WritableRoots {
		ownership.WritableRoots = appendUniquePath(ownership.WritableRoots, root)
	}
}

func (ownership *projectionOwnership) addVersion(relative string, version projectionFileVersion) {
	if ownership.ReadOnlyFiles == nil {
		ownership.ReadOnlyFiles = make(map[string][]projectionFileVersion)
	}
	for _, retained := range ownership.ReadOnlyFiles[relative] {
		if retained == version {
			return
		}
	}
	ownership.ReadOnlyFiles[relative] = append(ownership.ReadOnlyFiles[relative], version)
}

func appendUniquePath(paths []string, next string) []string {
	for _, retained := range paths {
		if retained == next {
			return paths
		}
	}
	paths = append(paths, next)
	sort.Strings(paths)
	return paths
}

func pathWithin(relative, root string) bool {
	return relative == root || strings.HasPrefix(relative, root+string(filepath.Separator))
}

func (ownership projectionOwnership) writable(relative string) bool {
	for _, root := range ownership.WritableRoots {
		if pathWithin(relative, root) {
			return true
		}
	}
	return false
}

func validatePendingProjection(record ViewRecord) error {
	pending := record.Pending
	if pending == nil {
		return nil
	}
	if !record.Unready {
		return ErrProjectionRecoveryRequired
	}
	for _, root := range append(append([]string(nil), pending.Ownership.ReadOnlyRoots...), pending.Ownership.WritableRoots...) {
		if _, err := safeJoin(record.WorkspacePath, filepath.ToSlash(root)); err != nil || filepath.Clean(root) != root {
			return ErrProjectionRecoveryRequired
		}
	}
	for relative, versions := range pending.Ownership.ReadOnlyFiles {
		if _, err := safeJoin(record.WorkspacePath, filepath.ToSlash(relative)); err != nil || filepath.Clean(relative) != relative || len(versions) == 0 {
			return ErrProjectionRecoveryRequired
		}
		ownedRoot := false
		for _, root := range pending.Ownership.ReadOnlyRoots {
			ownedRoot = ownedRoot || pathWithin(relative, root)
		}
		if !ownedRoot {
			return ErrProjectionRecoveryRequired
		}
		for _, version := range versions {
			if len(version.SHA256) != 64 || version.SizeBytes < 0 {
				return ErrProjectionRecoveryRequired
			}
			if _, err := hex.DecodeString(version.SHA256); err != nil {
				return ErrProjectionRecoveryRequired
			}
		}
	}
	return nil
}

func encodePendingProjection(pending *pendingProjection) (any, error) {
	if pending == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(pending)
	if err != nil {
		return nil, err
	}
	return string(encoded), nil
}
