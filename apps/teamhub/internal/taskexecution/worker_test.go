package taskexecution

import (
	"encoding/json"
	"testing"
)

func TestDecodeWorkerPayloadIsStrict(t *testing.T) {
	var valid effectIDPayload
	if err := decodeWorkerPayload(json.RawMessage(`{"effect_id":"effect_1"}`), &valid); err != nil || valid.EffectID != "effect_1" {
		t.Fatalf("decode valid payload=%+v err=%v", valid, err)
	}
	for _, raw := range []string{
		`{"effect_id":"effect_1","unexpected":true}`,
		`{"effect_id":"effect_1"} {}`,
	} {
		var value effectIDPayload
		if err := decodeWorkerPayload(json.RawMessage(raw), &value); err == nil {
			t.Fatalf("accepted non-canonical worker payload %s", raw)
		}
	}
}

func TestScheduleReconcilePayloadIsBoundedAndStrict(t *testing.T) {
	for _, raw := range []string{
		`{"reconcile_after_seconds":0}`,
		`{"reconcile_after_seconds":301}`,
		`{"reconcile_after_seconds":5,"worker_time":"untrusted"}`,
	} {
		var payload scheduleReconcilePayload
		err := decodeWorkerPayload(json.RawMessage(raw), &payload)
		if err == nil && payload.ReconcileAfterSeconds >= 1 && payload.ReconcileAfterSeconds <= 300 {
			t.Fatalf("accepted invalid schedule_reconcile payload %s", raw)
		}
	}
}
