package lingercontext

import (
	"context"
	"encoding/json"
	"errors"
	"path"
)

const localCopySourcesPerDigest = 3

// localCopySource names one committed read-only file on this computer whose
// bytes may be identical to a download job. Every use is verified like a download.
type localCopySource struct {
	workspace string
	relative  string
	path      string
}

// localCopySources indexes read-only files of committed Views of the same tenant
// by SHA-256, for the digests that jobs still need. Sources of the same agent
// come first so they fill the per-digest cap before other agents' sources. A
// failed query means no sources, so every job downloads as before.
func (s *ViewStore) localCopySources(ctx context.Context, view View, jobs []downloadJob) map[string][]localCopySource {
	wanted := make(map[string]bool, len(jobs))
	for _, job := range jobs {
		wanted[job.input.SHA256] = true
	}
	rows, err := s.db.QueryContext(ctx, `SELECT view_json, workspace_path FROM context_views_v3 WHERE ready=1 AND json_extract(view_json,'$.tenant_id')=? ORDER BY json_extract(view_json,'$.agent_id')=? DESC`, view.TenantID, view.AgentID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	sources := make(map[string][]localCopySource)
	for rows.Next() {
		var encoded, workspace string
		if rows.Scan(&encoded, &workspace) != nil {
			continue
		}
		var committed View
		if json.Unmarshal([]byte(encoded), &committed) != nil {
			continue
		}
		for _, mapping := range committed.Mappings {
			if mapping.Access == "read_write" {
				continue
			}
			for _, file := range mapping.Files {
				if !wanted[file.SHA256] || len(sources[file.SHA256]) >= localCopySourcesPerDigest {
					continue
				}
				sourcePath, err := workspaceMappingFile(workspace, mapping.TargetPath, file.RelativePath)
				if err != nil {
					continue
				}
				sources[file.SHA256] = append(sources[file.SHA256], localCopySource{
					workspace: workspace,
					relative:  path.Join(mapping.TargetPath, file.RelativePath),
					path:      sourcePath,
				})
			}
		}
	}
	return sources
}

// fetch fills job.target from the first local source that verifies, then falls
// back to HTTP. It reports whether the bytes came from a local copy.
func (s *ViewStore) fetch(ctx context.Context, job downloadJob) (bool, error) {
	for _, source := range job.sources {
		if s.copyLocal(ctx, source, job.input, job.target) == nil {
			return true, nil
		}
	}
	return false, s.download(ctx, job)
}

func (s *ViewStore) copyLocal(ctx context.Context, source localCopySource, input FileInput, target string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	identity, err := projectionIdentity(source.path)
	if err != nil || identity.Size != input.SizeBytes {
		return errors.New("local copy source is unavailable")
	}
	file, err := openContextFile(source.workspace, source.relative)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != input.SizeBytes {
		return errors.New("local copy source is unavailable")
	}
	return writeVerifiedFile(target, file, input)
}
