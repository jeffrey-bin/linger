package app

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

// registerVoice builds voice media when SONIOX_API_KEY or XAI_API_KEY is set,
// or takes the plane a test injects. Soniox turns on transcription
// (Recording, dictation and Pocket Notes) with archive recovery; xAI turns on
// Live alone. Without either voice stays off: the Voice Runtime callbacks
// answer not found, the Voice media policy reports nothing supported, and no
// voice retention rule or job exists.
func (a *App) registerVoice(cfg config.VoiceConfig, injected voicemedia.Plane, objects artifactstore.ObjectStore, stagingRoot string) error {
	media := injected
	a.voiceTranscription = injected != nil || cfg.SonioxAPIKey != ""
	if media == nil && (cfg.SonioxAPIKey != "" || cfg.XaiAPIKey != "") {
		service, recordings, err := newVoiceMedia(a.pool, objects, stagingRoot, a.documents, cfg)
		if err != nil {
			return err
		}
		media, a.voiceRecordings = service, recordings
	}
	if media == nil {
		return nil
	}
	a.voiceMedia = media
	return nil
}

// addVoiceJobs registers the voice River jobs when the voice media plane has
// them.
func (a *App) addVoiceJobs(features *featureSet) {
	service, ok := a.voiceMedia.(*voicemedia.Service)
	if !ok {
		return
	}
	service.AddWorkers(features.workers, features.queues, a.logger, func(ctx context.Context, captureID string) (time.Duration, error) {
		return a.voice.CompleteCaptureStep(ctx, captureID)
	})
	features.resume = append(features.resume, func(ctx context.Context) error {
		return voicemedia.ResumeJobs(ctx, a.pool)
	})
}

// newVoiceMedia builds voice media over LiveKit, with Soniox archive recovery
// when Soniox is configured. The recorder's HLS staging files live under
// stagingRoot.
func newVoiceMedia(pool *pgxpool.Pool, objects artifactstore.ObjectStore, stagingRoot string, documents *document.Service, cfg config.VoiceConfig) (*voicemedia.Service, *voicemedia.LocalStagingStore, error) {
	liveKitProvider, err := voicemedia.NewLiveKitProvider(voicemedia.LiveKitConfig{
		APIURL: cfg.LiveKitAPIURL, PublicURL: cfg.LiveKitURL,
		APIKey: cfg.LiveKitAPIKey, APISecret: cfg.LiveKitAPISecret,
		CredentialTTL:   config.VoiceMediaCredentialTTL,
		SegmentDuration: uint32(config.VoiceMediaSegmentDurationSeconds),
		StartTimeout:    config.VoiceMediaStartTimeout, StopTimeout: config.VoiceMediaStopTimeout,
	}, pool)
	if err != nil {
		return nil, nil, fmt.Errorf("configure LiveKit voice media provider: %w", err)
	}
	recordings := voicemedia.NewLocalStagingStore(pool, stagingRoot)
	materializer, err := voicemedia.NewHLSMaterializer(pool, objects, recordings)
	if err != nil {
		return nil, nil, fmt.Errorf("configure voice media materializer: %w", err)
	}
	service := voicemedia.NewWithDocuments(pool, liveKitProvider, materializer, documents)
	if cfg.SonioxAPIKey != "" {
		archiveTranscriber, err := voicetranscription.NewSonioxTranscriber(voicetranscription.SonioxConfig{
			APIKey: cfg.SonioxAPIKey, LanguageHints: voicetranscription.SonioxLanguageHints,
		})
		if err != nil {
			return nil, nil, fmt.Errorf("configure voice transcription: %w", err)
		}
		service.SetArchiveTranscriber(archiveTranscriber, voice.NormalizeCaptureTranscript)
		service.SetArchiveRecoveryConcurrency(config.VoiceArchiveRecoveryConcurrency)
	}
	return service, recordings, nil
}
