package lingercontext

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"syscall"
)

type projectionMutationKind string

const (
	projectionMutationReplace projectionMutationKind = "replace"
	projectionMutationDelete  projectionMutationKind = "delete"
	projectionMutationLink    projectionMutationKind = "link"
)

func validateProjectionUpdate(workspace string, previous projectionOwnership, committed, next []Mapping) error {
	current := projectionOwnership{}
	if err := current.addMappings(workspace, next); err != nil {
		return err
	}
	for _, readonly := range current.ReadOnlyRoots {
		for _, writable := range current.WritableRoots {
			if pathWithin(readonly, writable) || pathWithin(writable, readonly) {
				return ErrContextConflict
			}
		}
	}
	root, err := os.OpenRoot(workspace)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer root.Close()
	for _, readonly := range current.ReadOnlyRoots {
		for _, writable := range previous.WritableRoots {
			if pathWithin(readonly, writable) || pathWithin(writable, readonly) {
				if _, err := root.Lstat(writable); err == nil {
					return ErrContextConflict
				} else if !errors.Is(err, os.ErrNotExist) {
					return err
				}
			}
		}
	}
	committedFiles, err := committedProjectionFiles(workspace, committed)
	if err != nil {
		return err
	}
	for relative := range current.ReadOnlyFiles {
		if _, err := root.Lstat(relative); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		owned, err := ownedProjectionFile(root, relative, previous, committedFiles)
		if err != nil {
			return err
		}
		if !owned {
			return ErrContextConflict
		}
	}
	return nil
}

func committedProjectionFiles(workspace string, mappings []Mapping) (map[string][]projectionFileVersion, error) {
	ownership := projectionOwnership{}
	if err := ownership.addMappings(workspace, mappings); err != nil {
		return nil, err
	}
	return ownership.ReadOnlyFiles, nil
}

func ownedProjectionFile(root *os.Root, relative string, ownership projectionOwnership, committed map[string][]projectionFileVersion) (bool, error) {
	info, err := root.Lstat(relative)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || ownership.writable(relative) {
		return false, nil
	}
	if _, owned := committed[relative]; owned {
		return true, nil
	}
	versions := ownership.ReadOnlyFiles[relative]
	if versions == nil {
		// On a case-insensitive file system a page renamed only in letter case
		// finds its previous file under the new name.
		if _, ok := caseAlias(root, relative, info, slices.Collect(maps.Keys(committed))); ok {
			return true, nil
		}
		if alias, ok := caseAlias(root, relative, info, slices.Collect(maps.Keys(ownership.ReadOnlyFiles))); ok {
			versions = ownership.ReadOnlyFiles[alias]
		}
	}
	sizeMatches := false
	for _, version := range versions {
		sizeMatches = sizeMatches || version.SizeBytes == info.Size()
	}
	if !sizeMatches {
		return false, nil
	}
	file, err := root.Open(relative)
	if err != nil {
		return false, err
	}
	defer file.Close()
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, info.Size()+1))
	if err != nil {
		return false, err
	}
	if written != info.Size() {
		return false, nil
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	for _, version := range versions {
		if version.SizeBytes == written && version.SHA256 == digest {
			return true, nil
		}
	}
	return false, nil
}

func (s *ViewStore) publishProjection(workspace, staged string, previous projectionOwnership, committed, next []Mapping) error {
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return err
	}
	defer root.Close()
	workspaceRelative, err := filepath.Rel(s.root, workspace)
	if err != nil {
		return err
	}
	stagedRelative, err := filepath.Rel(s.root, staged)
	if err != nil {
		return err
	}
	if err := writableDirectories(root, workspaceRelative); err != nil {
		return err
	}
	workspaceRoot, err := root.OpenRoot(workspaceRelative)
	if err != nil {
		return err
	}
	defer workspaceRoot.Close()
	committedFiles, err := committedProjectionFiles(workspace, committed)
	if err != nil {
		return err
	}
	protected := projectionOwnership{}
	protected.merge(previous)
	if err := protected.addMappings(workspace, next); err != nil {
		return err
	}
	mappings := append([]Mapping(nil), next...)
	sort.SliceStable(mappings, func(left, right int) bool {
		return projectionOrder(mappings[left].Kind) < projectionOrder(mappings[right].Kind)
	})
	retained := make(map[string]bool)
	published := make(map[string]string)
	for _, mapping := range mappings {
		targetRoot, err := safeJoin(workspace, mapping.TargetPath)
		if err != nil {
			return err
		}
		targetRelative, err := filepath.Rel(s.root, targetRoot)
		if err != nil {
			return err
		}
		if err := writableDirectories(root, targetRelative); err != nil {
			return err
		}
		for _, input := range mapping.Files {
			target, err := safeJoin(targetRoot, input.RelativePath)
			if err != nil {
				return err
			}
			relative, err := filepath.Rel(s.root, target)
			if err != nil {
				return err
			}
			if digest, duplicate := published[relative]; duplicate {
				if digest != input.SHA256 {
					return errors.New("Context View maps multiple files to one path")
				}
				retained[relative] = true
				continue
			}
			published[relative] = input.SHA256
			retained[relative] = true
			if err := writableDirectories(root, filepath.Dir(relative)); err != nil {
				return err
			}
			workspacePath, err := filepath.Rel(workspace, target)
			if err != nil {
				return err
			}
			info, err := root.Lstat(relative)
			replace := false
			if err == nil {
				if !info.Mode().IsRegular() {
					return errors.New("Context projection target is not a regular file")
				}
				if mapping.Access == "read_write" {
					continue
				}
				replace, err = ownedProjectionFile(workspaceRoot, workspacePath, previous, committedFiles)
				if err != nil {
					return err
				}
				if !replace {
					return ErrContextConflict
				}
			} else if !errors.Is(err, os.ErrNotExist) {
				return err
			}
			source := filepath.Join(stagedRelative, mapping.TargetPath, input.RelativePath)
			if _, err := root.Lstat(source); errors.Is(err, os.ErrNotExist) {
				if retainExistingProjectionFile(root, relative, input, committed, mapping) {
					continue
				}
				return errors.New("Context projection source is missing")
			} else if err != nil {
				return err
			}
			if replace {
				// Replacing a file renamed only in letter case would keep its old
				// name on a case-insensitive file system; publish it fresh instead.
				stale, err := otherCaseName(root, relative)
				if err != nil {
					return err
				}
				if stale != "" {
					if err := root.Remove(stale); err != nil {
						return err
					}
					replace = false
				}
			}
			if replace {
				if err := replaceProjectionFile(root, source, relative); err != nil {
					return err
				}
				if s.projectionFault != nil {
					if err := s.projectionFault(projectionMutationReplace); err != nil {
						return err
					}
				}
			} else if err := root.Link(source, relative); err != nil {
				if mapping.Access == "read_write" && errors.Is(err, os.ErrExist) {
					if info, err := root.Lstat(relative); err == nil && info.Mode().IsRegular() {
						continue
					}
				}
				return err
			} else if err := root.Remove(source); err != nil {
				return err
			} else if s.projectionFault != nil {
				if err := s.projectionFault(projectionMutationLink); err != nil {
					return err
				}
			}
			if mapping.Access == "read_only" {
				mode := os.FileMode(0o400)
				if input.Executable {
					mode = 0o500
				}
				if err := chmodOpened(root, relative, mode); err != nil {
					return err
				}
				s.rememberVerifiedProjectionFile(target, input)
			}
			if err := syncDirectory(root, filepath.Dir(relative)); err != nil {
				return err
			}
		}
	}
	for workspacePath := range previous.ReadOnlyFiles {
		relative := filepath.Join(workspaceRelative, workspacePath)
		info, err := workspaceRoot.Lstat(workspacePath)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if protected.writable(workspacePath) {
			if !info.Mode().IsRegular() {
				continue
			}
			if err := chmodOpened(root, relative, 0o600|(info.Mode().Perm()&0o100)); err != nil {
				return err
			}
			continue
		}
		if retained[relative] {
			continue
		}
		// A file renamed only in letter case is the retained file itself on a
		// case-insensitive file system.
		if _, renamed := caseAlias(root, relative, info, slices.Collect(maps.Keys(retained))); renamed {
			continue
		}
		owned, err := ownedProjectionFile(workspaceRoot, workspacePath, previous, committedFiles)
		if err != nil {
			return err
		}
		if !owned {
			return ErrContextConflict
		}
		if err := writableDirectories(root, filepath.Dir(relative)); err != nil {
			return err
		}
		if err := root.Remove(relative); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if s.projectionFault != nil {
			if err := s.projectionFault(projectionMutationDelete); err != nil {
				return err
			}
		}
		if err := syncDirectory(root, filepath.Dir(relative)); err != nil {
			return err
		}
	}
	if err := pruneProjectionDirectories(root, workspaceRelative, previous, protected, next); err != nil {
		return err
	}
	if err := protectReadOnlyProjection(root, workspaceRelative, next); err != nil {
		return err
	}
	return syncDirectory(root, workspaceRelative)
}

func pruneProjectionDirectories(root *os.Root, workspace string, previous, protected projectionOwnership, next []Mapping) error {
	candidates := make(map[string]bool)
	retained := make(map[string]bool)
	for _, mapping := range next {
		retained[filepath.Clean(mapping.TargetPath)] = true
	}
	for _, ownedRoot := range previous.ReadOnlyRoots {
		candidates[ownedRoot] = true
		for file := range previous.ReadOnlyFiles {
			if !pathWithin(file, ownedRoot) {
				continue
			}
			for directory := filepath.Dir(file); pathWithin(directory, ownedRoot); directory = filepath.Dir(directory) {
				candidates[directory] = true
				if directory == ownedRoot {
					break
				}
			}
		}
	}
	ordered := make([]string, 0, len(candidates))
	for candidate := range candidates {
		ordered = append(ordered, candidate)
	}
	sort.Slice(ordered, func(left, right int) bool {
		if len(ordered[left]) == len(ordered[right]) {
			return ordered[left] < ordered[right]
		}
		return len(ordered[left]) > len(ordered[right])
	})
	for _, candidate := range ordered {
		if retained[candidate] || protected.writable(candidate) {
			continue
		}
		relative := filepath.Join(workspace, candidate)
		info, err := root.Lstat(relative)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return ErrContextConflict
		}
		// Darwin rmdir can silently remove dot-underscore metadata files.
		// Only attempt removal after verifying the directory is empty.
		directory, err := root.Open(relative)
		if err != nil {
			return err
		}
		entries, readErr := directory.ReadDir(1)
		closeErr := directory.Close()
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return readErr
		}
		if closeErr != nil {
			return closeErr
		}
		if len(entries) != 0 {
			continue
		}
		if err := writableDirectories(root, filepath.Dir(relative)); err != nil {
			return err
		}
		if err := root.Remove(relative); err != nil {
			if errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, os.ErrExist) {
				continue
			}
			if !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
		if err := syncDirectory(root, filepath.Dir(relative)); err != nil {
			return err
		}
	}
	return nil
}

func projectionOrder(kind string) int {
	if kind == "inbox_view" {
		return 1
	}
	return 0
}

func writableDirectories(root *os.Root, relative string) error {
	current := ""
	for _, component := range strings.Split(filepath.Clean(relative), string(filepath.Separator)) {
		if component == ".." || component == "" {
			return errors.New("Context directory escapes its root")
		}
		if component == "." {
			continue
		}
		current = filepath.Join(current, component)
		info, err := root.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			if err := root.Mkdir(current, 0o700); err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("Context directory is unsafe")
		} else if !samePermissionMode(info.Mode(), 0o700) {
			if err := chmodOpened(root, current, 0o700); err != nil {
				return err
			}
		}
	}
	return nil
}

func samePermissionMode(actual, expected os.FileMode) bool {
	const permissionBits = os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky
	return actual&permissionBits == expected&permissionBits
}

func chmodOpened(root *os.Root, relative string, mode os.FileMode) error {
	// Root.Chmod preserves root confinement and obtains the platform's required
	// attribute access. A read-only Windows handle cannot change file attributes.
	return root.Chmod(relative, mode)
}

func openContextFile(workspace, relative string) (*os.File, error) {
	if _, err := safeJoin(workspace, relative); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	current := ""
	for _, component := range strings.Split(filepath.Clean(relative), string(filepath.Separator)) {
		current = filepath.Join(current, component)
		info, err := root.Lstat(current)
		if err != nil {
			return nil, err
		}
		if directoryLink(info) {
			return nil, errors.New("Context file contains a symbolic link")
		}
	}
	// A Runtime may have replaced the file with a FIFO; the open must not block.
	return root.OpenFile(relative, contextFileOpenFlags, 0)
}

// protectReadOnlyProjection makes every directory of a read-only mapping
// read-only after its files are published.
func protectReadOnlyProjection(root *os.Root, workspaceRelative string, mappings []Mapping) error {
	for _, mapping := range mappings {
		if mapping.Access != "read_only" {
			continue
		}
		relative := filepath.Join(workspaceRelative, mapping.TargetPath)
		if err := fs.WalkDir(root.FS(), filepath.ToSlash(relative), func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return errors.New("Context projection contains a symbolic link")
			}
			if entry.IsDir() {
				info, err := entry.Info()
				if err != nil {
					return err
				}
				if samePermissionMode(info.Mode(), 0o500) {
					return nil
				}
				return chmodOpened(root, path, 0o500)
			}
			return nil
		}); err != nil {
			return err
		}
	}
	return nil
}

// caseAlias returns the candidate that differs from relative only in letter
// case and names the same file, as two such paths do on a case-insensitive
// file system. On a case-sensitive one they are different files.
func caseAlias(root *os.Root, relative string, info os.FileInfo, candidates []string) (string, bool) {
	for _, candidate := range candidates {
		if candidate == relative || !strings.EqualFold(candidate, relative) {
			continue
		}
		other, err := root.Lstat(candidate)
		if err == nil && os.SameFile(info, other) {
			return candidate, true
		}
	}
	return "", false
}

// otherCaseName returns the entry beside relative whose name differs from it
// only in letter case, or "" when there is none.
func otherCaseName(root *os.Root, relative string) (string, error) {
	directory, err := root.Open(filepath.Dir(relative))
	if err != nil {
		return "", err
	}
	defer directory.Close()
	names, err := directory.Readdirnames(-1)
	if err != nil {
		return "", err
	}
	base := filepath.Base(relative)
	for _, name := range names {
		if name != base && strings.EqualFold(name, base) {
			return filepath.Join(filepath.Dir(relative), name), nil
		}
	}
	return "", nil
}
