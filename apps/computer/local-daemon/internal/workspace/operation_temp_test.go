package workspace

import (
	"os"
	"testing"
)

func TestOperationTempLeasesKeepSweepLockUntilLastRelease(t *testing.T) {
	base := t.TempDir()
	temp, err := PrepareOperationTemp(base)
	if err != nil {
		t.Fatal(err)
	}
	defer temp.Close()
	first, err := temp.Retain()
	if err != nil {
		t.Fatal(err)
	}
	defer first()
	last, err := temp.Retain()
	if err != nil {
		t.Fatal(err)
	}
	defer last()
	for _, close := range []func() error{temp.Close, temp.Close, first, first} {
		if err := close(); err != nil {
			t.Fatal(err)
		}
	}
	if count, _, err := PruneOperationTemps(base, nil); err != nil || count != 0 {
		t.Fatalf("sweep removed a retained directory: %d, %v", count, err)
	}
	if err := os.WriteFile(temp.Path+"/still-owned", []byte("alive"), 0o600); err != nil {
		t.Fatalf("the last lease lost its temp directory: %v", err)
	}
	if err := last(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(temp.Path); !os.IsNotExist(err) {
		t.Fatalf("last release left the directory: %v", err)
	}
	if _, err := temp.Retain(); err == nil {
		t.Fatal("a released directory acquired a new lease")
	}
}
