package config

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

// RoomDocumentConfig keeps independent lifetimes for Document recovery and
// staging evidence.
type RoomDocumentConfig struct {
	RuntimeURL                  string
	AssetUploadStagingRetention time.Duration
	AssetGCGrace                time.Duration
	// AssetQuotas lowers Document Asset quotas in tests; a zero field keeps the
	// document package's quota. No environment variable sets it.
	AssetQuotas AssetQuotas
}

// AssetQuotas mirrors document.AssetOptions field for field, so the app
// converts it directly.
type AssetQuotas struct {
	MaxAssetBytes, MaxDocumentBytes, MaxTenantBytes, StorageReserveBytes int64
	MaxDocumentObjects, MaxTenantObjects                                 int32
}

func defaultRoomDocumentConfig() RoomDocumentConfig {
	return RoomDocumentConfig{
		AssetUploadStagingRetention: 24 * time.Hour,
		AssetGCGrace:                24 * time.Hour,
	}
}

func applyRoomDocumentEnvironment(target *RoomDocumentConfig) {
	setNonemptyEnvironment(&target.RuntimeURL, "TEAMHUB_DOCUMENT_RUNTIME_URL")
}

func validateRoomDocument(config *RoomDocumentConfig) error {
	if config.RuntimeURL != "" {
		parsed, err := url.Parse(config.RuntimeURL)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" ||
			(parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil ||
			(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
			return fmt.Errorf("invalid TEAMHUB_DOCUMENT_RUNTIME_URL %q", config.RuntimeURL)
		}
		config.RuntimeURL = strings.TrimRight(config.RuntimeURL, "/")
	}
	return nil
}
