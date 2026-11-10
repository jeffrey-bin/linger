package document

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
)

type downloadAssetEvidence struct {
	AssetID   string `json:"asset_id"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"size_bytes"`
}

func (s *Service) portableMarkdownDownload(ctx context.Context, input LatestDownloadInput, content LatestDownloadContent, manifest []downloadAssetEvidence) (LatestDownloadContent, error) {
	if len(manifest) == 0 {
		return content, nil
	}
	sourceReader, err := s.objects.Open(ctx, content.ObjectKey)
	if err != nil {
		return LatestDownloadContent{}, err
	}
	source, err := io.ReadAll(io.LimitReader(sourceReader, MaxPortableBytes+1))
	closeErr := sourceReader.Close()
	if err != nil {
		return LatestDownloadContent{}, err
	}
	if closeErr != nil {
		return LatestDownloadContent{}, closeErr
	}
	digest := sha256.Sum256(source)
	if int64(len(source)) != content.SizeBytes || hex.EncodeToString(digest[:]) != content.SHA256 {
		return LatestDownloadContent{}, ErrRevisionUnavailable
	}
	allowed := make(map[string]downloadAssetEvidence, len(manifest))
	for _, entry := range manifest {
		allowed[entry.AssetID] = entry
	}
	urls := map[string]string{}
	output, err := InlineAssets(source, func(id string) (string, error) {
		evidence, ok := allowed[id]
		if !ok {
			return "", ErrAssetUnavailable
		}
		if uri, ok := urls[id]; ok {
			return uri, nil
		}
		asset, err := s.OpenAssetContent(ctx, input.AccountID, id)
		if err != nil {
			return "", err
		}
		defer asset.Reader.Close()
		if asset.Asset.DocumentID != input.DocumentID || asset.Asset.SHA256 != evidence.SHA256 || asset.Asset.SizeBytes != evidence.SizeBytes {
			return "", ErrAssetUnavailable
		}
		if evidence.SizeBytes > MaxPortableBytes*3/4 {
			return "", ErrAssetQuotaExceeded
		}
		contents, err := io.ReadAll(io.LimitReader(asset.Reader, evidence.SizeBytes+1))
		if err != nil {
			return "", err
		}
		hash := sha256.Sum256(contents)
		if int64(len(contents)) != evidence.SizeBytes || hex.EncodeToString(hash[:]) != evidence.SHA256 {
			return "", ErrAssetContentMismatch
		}
		uri := "data:" + asset.Asset.MediaType + ";base64," + base64.StdEncoding.EncodeToString(contents)
		urls[id] = uri
		return uri, nil
	})
	if err != nil {
		return LatestDownloadContent{}, markdownError(err)
	}
	content.InlineBytes = output
	content.ObjectKey = ""
	content.SizeBytes = int64(len(output))
	digest = sha256.Sum256(output)
	content.SHA256 = hex.EncodeToString(digest[:])
	return content, nil
}
