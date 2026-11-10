package agentregistry

import "testing"

func TestWritableWorkspaceGrantExists(t *testing.T) {
	grants := []byte(`[{"grant_id":"grant_write","mode":"workspace-write"},{"grant_id":"grant_read","mode":"read-only"}]`)
	cases := []struct {
		name    string
		raw     []byte
		grantID string
		want    bool
	}{
		{name: "writable grant", raw: grants, grantID: "grant_write", want: true},
		{name: "read-only grant", raw: grants, grantID: "grant_read"},
		{name: "unknown grant", raw: grants, grantID: "grant_other"},
		{name: "empty grant ID", raw: grants},
		{name: "malformed grants", raw: []byte(`{`), grantID: "grant_write"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := writableWorkspaceGrantExists(tc.raw, tc.grantID); got != tc.want {
				t.Fatalf("writableWorkspaceGrantExists=%v want %v", got, tc.want)
			}
		})
	}
}
