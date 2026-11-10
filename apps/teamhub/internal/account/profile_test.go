package account

import (
	"errors"
	"testing"
)

func TestMergeGeneratedFillsUnlockedFieldsOnly(t *testing.T) {
	current := record{Name: "Alice", Bio: "", Organization: "Old Co", BioUserManaged: false, OrganizationUserManaged: true}
	next := mergeGenerated(current, Fields{Name: "Alicia Chen", Bio: "Builds collaboration tools.", Organization: "Generated Co"})
	if next.Name != "Alicia Chen" || next.Bio != "Builds collaboration tools." || next.Organization != "Old Co" {
		t.Fatalf("merged %+v", next)
	}
	if next.OrganizationUserManaged != true || next.BioUserManaged {
		t.Fatalf("managed flags %+v", next)
	}
}

func TestMergeGeneratedSkipsEmptyGeneratedValues(t *testing.T) {
	current := record{Name: "Alice", Bio: "Existing"}
	next := mergeGenerated(current, Fields{})
	if next.Name != "Alice" || next.Bio != "Existing" {
		t.Fatalf("empty generation overwrote %+v", next)
	}
}

func TestApplyPatchFreezesClearedFields(t *testing.T) {
	bio := ""
	organization := "Linger"
	name := "Jenny Wen"
	next, err := applyPatch(record{Name: "Jenny Bin", Bio: "Old"}, Patch{
		Name: &name, Bio: &bio, Organization: &organization,
	})
	if err != nil {
		t.Fatal(err)
	}
	if next.Name != "Jenny Wen" || next.Bio != "" || next.Organization != "Linger" {
		t.Fatalf("patched %+v", next)
	}
	if !next.NameUserManaged || !next.BioUserManaged || !next.OrganizationUserManaged {
		t.Fatalf("cleared fields must freeze %+v", next)
	}
	locked := mergeGenerated(next, Fields{Name: "Other", Bio: "Generated bio", Organization: "Other Co"})
	if locked.Name != "Jenny Wen" || locked.Bio != "" || locked.Organization != "Linger" {
		t.Fatalf("frozen fields overwritten %+v", locked)
	}
}

func TestApplyPatchRejectsEmptyName(t *testing.T) {
	name := "  "
	if _, err := applyPatch(record{Name: "Alice"}, Patch{Name: &name}); !errors.Is(err, ErrProfileInvalid) {
		t.Fatalf("got %v", err)
	}
}
