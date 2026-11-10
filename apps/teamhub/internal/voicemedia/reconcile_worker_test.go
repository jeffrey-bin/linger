package voicemedia

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestVoiceMediaDataPlaneStalledDetectsMissingAndStoppedSegments(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)

	for name, test := range map[string]struct {
		count   int64
		last    pgtype.Timestamptz
		created pgtype.Timestamptz
		want    bool
	}{
		"awaiting first segment": {
			created: pgtype.Timestamptz{Time: now.Add(-voiceMediaFirstSegmentTimeout + time.Millisecond), Valid: true},
		},
		"first segment timed out": {
			created: pgtype.Timestamptz{Time: now.Add(-voiceMediaFirstSegmentTimeout), Valid: true},
			want:    true,
		},
		"no timestamp after data": {count: 1},
		"still progressing": {
			count: 1,
			last:  pgtype.Timestamptz{Time: now.Add(-voiceMediaSegmentStallTimeout + time.Millisecond), Valid: true},
		},
		"stalled": {
			count: 1,
			last:  pgtype.Timestamptz{Time: now.Add(-voiceMediaSegmentStallTimeout), Valid: true},
			want:  true,
		},
	} {
		t.Run(name, func(t *testing.T) {
			if got := voiceMediaDataPlaneStalled(test.count, test.last, test.created, now); got != test.want {
				t.Fatalf("voiceMediaDataPlaneStalled()=%t want=%t", got, test.want)
			}
		})
	}
}

func TestVoiceMediaFinalizingWithoutEgressExpiresOnlyTerminalShape(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	base := store.ListVoiceMediaEpochsForReconcileRow{
		CaptureStatus:    "finalizing",
		DesiredState:     "sealed",
		ObservedState:    "unknown",
		CreatedAt:        pgtype.Timestamptz{Time: now.Add(-voiceMediaNoEgressFinalizationTimeout), Valid: true},
		ProviderEgressID: pgtype.Text{Valid: false},
	}
	missing := providerObservation{State: "unknown", Missing: true}
	if !voiceMediaFinalizingWithoutEgressExpired(base, missing, now) {
		t.Fatal("finalizing epoch without a recorder report should expire after the grace period")
	}

	for name, mutate := range map[string]func(*store.ListVoiceMediaEpochsForReconcileRow){
		"still starting": func(row *store.ListVoiceMediaEpochsForReconcileRow) { row.CaptureStatus = "starting" },
		"not sealed":     func(row *store.ListVoiceMediaEpochsForReconcileRow) { row.DesiredState = "active" },
		"has egress": func(row *store.ListVoiceMediaEpochsForReconcileRow) {
			row.ProviderEgressID = pgtype.Text{String: "egress", Valid: true}
		},
		"within grace": func(row *store.ListVoiceMediaEpochsForReconcileRow) {
			row.CreatedAt.Time = now.Add(-voiceMediaNoEgressFinalizationTimeout + time.Millisecond)
		},
	} {
		t.Run(name, func(t *testing.T) {
			row := base
			mutate(&row)
			if voiceMediaFinalizingWithoutEgressExpired(row, missing, now) {
				t.Fatal("non-terminal or too-young epoch was treated as expired")
			}
		})
	}
	for _, observation := range []providerObservation{{State: "unknown"}, {State: "active", EgressID: "recovered"}} {
		if voiceMediaFinalizingWithoutEgressExpired(base, observation, now) {
			t.Fatal("ambiguous or recovered provider observation was treated as absent")
		}
	}
	base.ProviderEgressID = pgtype.Text{String: "egress-lost", Valid: true}
	base.StopRequestedAt = pgtype.Timestamptz{Time: now.Add(-voiceMediaNoEgressFinalizationTimeout), Valid: true}
	if !voiceMediaFinalizingWithoutEgressExpired(base, missing, now) {
		t.Fatal("confirmed disappearance of a known recorder leaves Stop waiting forever")
	}
	base.StopRequestedAt.Time = now
	if voiceMediaFinalizingWithoutEgressExpired(base, missing, now) {
		t.Fatal("old recording age bypasses the Stop grace period")
	}
}

func TestAbsoluteVoiceMediaEndAddsRecoveredEpochBase(t *testing.T) {
	if got := absoluteVoiceMediaEnd(12_500, 8_000); got != 20_500 {
		t.Fatalf("absoluteVoiceMediaEnd()=%d want=20500", got)
	}
	if got := absoluteVoiceMediaEnd(12_500, 0); got != 12_500 {
		t.Fatalf("absoluteVoiceMediaEnd()=%d want=12500", got)
	}
}
