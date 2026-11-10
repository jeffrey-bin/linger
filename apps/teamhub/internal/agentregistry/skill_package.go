package agentregistry

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"sort"
	"time"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
)

func (s *Service) storeSkillPackageFiles(ctx context.Context, pkg skill.Package) ([]storedSkillPackageFile, error) {
	stored := make([]storedSkillPackageFile, 0, len(pkg.Files))
	for _, file := range pkg.Files {
		object, err := s.artifacts.Put(ctx, bytes.NewReader(file.Content))
		if err != nil {
			s.deleteSkillPackageObjects(ctx, stored)
			return nil, err
		}
		stored = append(stored, storedSkillPackageFile{File: file, Object: object})
	}
	return stored, nil
}

func (s *Service) deleteSkillPackageObjects(ctx context.Context, files []storedSkillPackageFile) {
	for _, file := range files {
		if err := artifactstore.DeleteDetached(ctx, s.artifacts, file.Object.Key); err != nil {
			s.logger.Error("remove uncommitted Skill Package object", "object_key", file.Object.Key, "error", err)
		}
	}
}

func (s *Service) readSkillPackageObject(ctx context.Context, objectKey string, size int64, expectedHash []byte) ([]byte, error) {
	// Database metadata defines the immutable content; reads verify the length and hash again and reject corrupted or replaced storage objects.
	object, err := s.artifacts.Open(ctx, objectKey)
	if err != nil {
		return nil, err
	}
	content, readErr := io.ReadAll(io.LimitReader(object, size+1))
	closeErr := object.Close()
	if readErr != nil || closeErr != nil {
		return nil, errors.Join(readErr, closeErr)
	}
	digest := sha256.Sum256(content)
	if int64(len(content)) != size || !bytes.Equal(digest[:], expectedHash) {
		return nil, errors.New("stored Skill Package file failed its immutable metadata check")
	}
	return content, nil
}

func writeSkillPackageZIP(destination io.Writer, packageName string, files []skill.PackageFile) error {
	// Fixed order, timestamps, permissions, and compression keep the download bytes of the same immutable Package stable.
	ordered := append([]skill.PackageFile(nil), files...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Path < ordered[j].Path })
	writer := zip.NewWriter(destination)
	fixedTime := time.Date(1980, time.January, 1, 0, 0, 0, 0, time.UTC)
	for _, file := range ordered {
		header := &zip.FileHeader{Name: packageName + "/" + file.Path, Method: zip.Store, Modified: fixedTime}
		header.SetMode(0o644)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			_ = writer.Close()
			return err
		}
		if _, err = entry.Write(file.Content); err != nil {
			_ = writer.Close()
			return err
		}
	}
	return writer.Close()
}
