package lingercontext

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"time"
)

// Some filesystems coalesce rapid chmod/write operations into one timestamp tick.
// Revalidate fresh files until a later write must receive a distinct identity.
const projectionIdentityReuseDelay = time.Second

type downloadJob struct {
	input      FileInput
	target     string
	contentURL string
	sources    []localCopySource
	localCopy  bool
}

type projectionFileIdentity struct {
	Device       uint64
	Inode        uint64
	Size         int64
	Mode         uint32
	ModifiedNsec int64
	ChangedNsec  int64
	Cacheable    bool
}

type verifiedProjectionFile struct {
	Identity  projectionFileIdentity
	SHA256    string
	SizeBytes int64
}

func workspaceMappingFile(workspace, mappingTarget, relative string) (string, error) {
	if workspace == "" || mappingTarget == "" || relative == "" {
		return "", errors.New("workspace mapping path is incomplete")
	}
	mappingRoot, err := safeJoin(workspace, mappingTarget)
	if err != nil {
		return "", err
	}
	return safeJoin(mappingRoot, relative)
}

func previousFileInput(mappings []Mapping, mapping Mapping, relative string) (FileInput, bool) {
	for _, previous := range mappings {
		if previous.Kind != mapping.Kind || previous.TargetPath != mapping.TargetPath {
			continue
		}
		for _, file := range previous.Files {
			if file.RelativePath == relative {
				return file, true
			}
		}
	}
	return FileInput{}, false
}

func (s *ViewStore) fileHasDigest(path, want string, size int64) bool {
	if path == "" || len(want) != 64 || size < 0 {
		return false
	}
	before, err := projectionIdentity(path)
	if err != nil || !before.Cacheable || before.Size != size {
		return false
	}
	s.verifiedMu.Lock()
	verified, ok := s.verifiedProjectionFiles[path]
	s.verifiedMu.Unlock()
	if ok && verified.Identity == before && verified.SHA256 == want && verified.SizeBytes == size && projectionIdentityCanBeReused(before, s.now()) {
		return true
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	s.verifiedMu.Lock()
	s.projectionDigestReads++
	s.verifiedMu.Unlock()
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, size+1))
	if err != nil || written != size {
		return false
	}
	after, err := projectionIdentity(path)
	if err != nil || after != before || hex.EncodeToString(hash.Sum(nil)) != want {
		return false
	}
	s.rememberVerified(path, verifiedProjectionFile{Identity: after, SHA256: want, SizeBytes: size})
	return true
}

func projectionIdentityCanBeReused(identity projectionFileIdentity, now time.Time) bool {
	latestChange := identity.ModifiedNsec
	if identity.ChangedNsec > latestChange {
		latestChange = identity.ChangedNsec
	}
	if !identity.Cacheable || latestChange <= 0 {
		return false
	}
	age := now.UnixNano() - latestChange
	return age >= int64(projectionIdentityReuseDelay)
}

func (s *ViewStore) rememberVerifiedProjectionFile(path string, input FileInput) {
	identity, err := projectionIdentity(path)
	if err != nil || !identity.Cacheable || identity.Size != input.SizeBytes {
		return
	}
	s.rememberVerified(path, verifiedProjectionFile{Identity: identity, SHA256: input.SHA256, SizeBytes: input.SizeBytes})
}

func (s *ViewStore) rememberVerified(path string, verified verifiedProjectionFile) {
	s.verifiedMu.Lock()
	defer s.verifiedMu.Unlock()
	s.verifiedProjectionFiles[path] = verified
}

func retainExistingProjectionFile(root *os.Root, relative string, input FileInput, previous []Mapping, mapping Mapping) bool {
	if mapping.Access == "read_write" {
		return false
	}
	retained, ok := previousFileInput(previous, mapping, input.RelativePath)
	if !ok || !sameProjectionContent(retained, input) {
		return false
	}
	info, err := root.Lstat(relative)
	return err == nil && info.Mode().IsRegular() && info.Size() == input.SizeBytes
}

func sameProjectionContent(left, right FileInput) bool {
	return left.SHA256 == right.SHA256 && left.Executable == right.Executable
}
