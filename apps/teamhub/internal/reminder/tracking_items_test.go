package reminder

import "testing"

func TestTrackingFieldsKeepVagueTimeWithoutInventingDeadline(t *testing.T) {
	vague := "next week"
	fields := TrackingFields{Kind: "todo", Content: "submit the report", DueText: &vague, SourceRef: "message:one", SourceDate: "2026-10-23", SourceTimezone: "Asia/Shanghai"}
	if err := validateTrackingFields(fields); err != nil {
		t.Fatal(err)
	}
	fields.SourceTimezone = "not-a-timezone"
	if validateTrackingFields(fields) == nil {
		t.Fatal("unknown timezone accepted")
	}
	fields.SourceTimezone = "UTC"
	fields.SourceDate = "next week"
	if validateTrackingFields(fields) == nil {
		t.Fatal("relative source date accepted")
	}
}
func TestTrackingIdentityIsStableAndOwnerScoped(t *testing.T) {
	a := TrackingOwner{TenantID: "one", ActorID: "alice"}
	b := TrackingOwner{TenantID: "one", ActorID: "bob"}
	first, again := trackingStableID(a, "trip"), trackingStableID(a, "trip")
	if first != again || first == trackingStableID(b, "trip") {
		t.Fatal("unstable or cross-owner identity")
	}
	if trackingStableID(a, "trip") == trackingStableID(a, "other") {
		t.Fatal("different matter reused identity")
	}
}
