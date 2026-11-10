package localtools

import (
	"encoding/json"
	"runtime"
	"testing"
)

func TestCuaPermissionAttributionRequiresExplicitEmbedding(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows uses UI Automation rather than macOS permission attribution")
	}
	for _, test := range []struct {
		source   string
		embedded bool
		want     bool
	}{
		{`{"attribution":"driver-daemon"}`, false, true},
		{`{"attribution":"host","embedded":true}`, false, false},
		{`{"attribution":"caller"}`, false, false},
		{`{"attribution":"host","embedded":true}`, true, true},
		{`{"attribution":"host","embedded":false}`, true, false},
		{`{"attribution":"driver-daemon"}`, true, false},
		{`{"attribution":"caller"}`, true, false},
	} {
		var permission cuaResult
		if err := json.Unmarshal([]byte(`{"structuredContent":{"accessibility":true,"screen_recording":true,"source":`+test.source+`}}`), &permission); err != nil {
			t.Fatal(err)
		}
		if got := cuaPermissionsGranted(permission, test.embedded); got != test.want {
			t.Fatalf("source=%s embedded=%v got=%v", test.source, test.embedded, got)
		}
		permission.Structured.Accessibility = false
		if cuaPermissionsGranted(permission, test.embedded) {
			t.Fatal("missing OS permission accepted")
		}
		permission.Structured.Accessibility = true
		permission.IsError = true
		if cuaPermissionsGranted(permission, test.embedded) {
			t.Fatal("driver error accepted")
		}
	}
}

func TestCuaWindowsPermissionsRequireUIA(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows UI Automation permission")
	}
	for _, test := range []struct{ uia, isError, want bool }{{true, false, true}, {false, false, false}, {true, true, false}} {
		var permission cuaResult
		permission.Structured.UIA = test.uia
		permission.IsError = test.isError
		if got := cuaPermissionsGranted(permission, false); got != test.want {
			t.Fatalf("uia=%v isError=%v got=%v", test.uia, test.isError, got)
		}
	}
}
