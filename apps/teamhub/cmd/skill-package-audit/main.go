package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
)

type runOptions struct {
	concurrency   int
	repairBuiltin bool
}

type auditOutput struct {
	ManifestCount     int   `json:"manifest_count"`
	FileCount         int   `json:"file_count"`
	UniqueObjectCount int   `json:"unique_object_count"`
	HeadChecks        int   `json:"head_checks"`
	BodyReads         int   `json:"body_reads"`
	BytesVerified     int64 `json:"bytes_verified"`
	DurationMS        int64 `json:"duration_ms"`
}

func main() {
	concurrency := flag.Int("concurrency", skill.DefaultPackageAuditConcurrency, "maximum concurrent object-store verifications")
	repairBuiltin := flag.Bool("repair-builtin", false, "first verify every built-in Skill Package and repair missing objects, including sealed Manifests")
	timeout := flag.Duration("timeout", 30*time.Minute, "maximum total command duration")
	flag.Parse()
	if err := execute(runOptions{concurrency: *concurrency, repairBuiltin: *repairBuiltin}, *timeout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func execute(options runOptions, timeout time.Duration) error {
	if options.concurrency < 1 {
		return errors.New("--concurrency must be at least 1")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	storageMaxBytes := max(cfg.ArtifactMaxBytes, config.SkillPackageMaxFileBytes, cfg.CaptureMaxBytes)
	objects, err := artifactstore.NewLocalStore(cfg.ArtifactStorageRoot, storageMaxBytes)
	if err != nil {
		return fmt.Errorf("configure artifact object storage: %w", err)
	}
	stats, err := run(ctx, pool, objects, options)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(auditOutput{
		ManifestCount:     stats.ManifestCount,
		FileCount:         stats.FileCount,
		UniqueObjectCount: stats.UniqueObjectCount,
		HeadChecks:        stats.HeadChecks,
		BodyReads:         stats.BodyReads,
		BytesVerified:     stats.BytesVerified,
		DurationMS:        stats.Duration.Milliseconds(),
	})
}

func run(
	ctx context.Context,
	pool *pgxpool.Pool,
	objects artifactstore.ObjectStore,
	options runOptions,
) (skill.AuditStats, error) {
	if options.repairBuiltin {
		if err := skill.EnsureVerified(ctx, pool, objects); err != nil {
			return skill.AuditStats{}, fmt.Errorf("repair built-in Skill Packages: %w", err)
		}
	}
	return skill.AuditPackagesWithOptions(ctx, pool, objects, skill.AuditOptions{
		MaxConcurrency: options.concurrency,
	})
}
