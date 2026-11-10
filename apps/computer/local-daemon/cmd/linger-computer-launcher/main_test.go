package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func fixture(t *testing.T) (string, string, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "private installation")
	bundle := filepath.Join(root, "lib-0123456789abcdef-abcd")
	for _, dir := range []string{root, filepath.Join(root, "bin"), filepath.Join(bundle, "cli"), filepath.Join(bundle, "runtime", "bin")} {
		if err := privatefs.EnsureDir(dir); err != nil {
			t.Fatal(err)
		}
	}
	launcher := filepath.Join(root, "bin", "linger-computer-ci.exe")
	for _, file := range []string{launcher, filepath.Join(bundle, "cli", "teamhub.exe"), filepath.Join(bundle, "cli", "linger-computer.exe"), filepath.Join(bundle, "cli", "teamhub.js"), filepath.Join(bundle, "runtime", "bin", "node.exe")} {
		if err := privatefs.WriteFile(file, []byte("fixture"), true); err != nil {
			t.Fatal(err)
		}
	}
	config, _ := json.Marshal(launcherConfig{SchemaVersion: 1, DataRoot: root})
	if err := privatefs.WriteFile(filepath.Join(root, "bin", "linger-computer-ci.launcher.json"), config, true); err != nil {
		t.Fatal(err)
	}
	if err := privatefs.WriteFile(filepath.Join(root, "active-bundle"), []byte(filepath.Base(bundle)), true); err != nil {
		t.Fatal(err)
	}
	return root, bundle, launcher
}

func TestInstalledNativeTargets(t *testing.T) {
	root, bundle, launcher := fixture(t)
	computer, err := resolveTarget(launcher)
	if err != nil || computer.dataRoot != root || computer.program != filepath.Join(bundle, "cli", "linger-computer.exe") || len(computer.arguments) != 0 ||
		computer.command != "linger-computer-ci" || computer.launcher != launcher {
		t.Fatalf("Computer target: %+v, %v", computer, err)
	}
	teamhub, err := resolveTarget(filepath.Join(bundle, "cli", "teamhub.exe"))
	if err != nil || teamhub.program != filepath.Join(bundle, "runtime", "bin", "node.exe") || !slices.Equal(teamhub.arguments, []string{"--use-env-proxy", filepath.Join(bundle, "cli", "teamhub.js")}) {
		t.Fatalf("TeamHub target: %+v, %v", teamhub, err)
	}
}

func TestNativeLauncherRejectsRedirectedTargets(t *testing.T) {
	for _, pointer := range []string{"..", "../foreign", "lib-0123456789abcdef-abcd/../../foreign", "C:\\foreign", ""} {
		t.Run(pointer, func(t *testing.T) {
			root, _, launcher := fixture(t)
			if err := privatefs.WriteFile(filepath.Join(root, "active-bundle"), []byte(pointer), false); err != nil {
				t.Fatal(err)
			}
			if _, err := resolveTarget(launcher); err == nil {
				t.Fatal("unsafe bundle pointer was accepted")
			}
		})
	}
	_, bundle, launcher := fixture(t)
	if err := os.Remove(filepath.Join(bundle, "cli", "linger-computer.exe")); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveTarget(launcher); err == nil {
		t.Fatal("a missing installed CLI must not fall back to PATH")
	}
}

func TestNativeLauncherRejectsDifferentDataRootBeforeExecution(t *testing.T) {
	root, _, launcher := fixture(t)
	other := filepath.Join(t.TempDir(), "other computer")
	t.Setenv("LINGER_COMPUTER_DATA_DIR", other)
	if err := run(launcher, []string{"stop"}); err == nil || !strings.Contains(err.Error(), "differs from this launcher installation") {
		t.Fatalf("different instance was not rejected before executing the CLI: %v", err)
	}
	if got := os.Getenv("LINGER_COMPUTER_DATA_DIR"); got != other {
		t.Fatalf("caller selection was changed to %q", got)
	}
	for _, value := range []string{"", root, root + string(os.PathSeparator), filepath.Join(root, "child") + string(os.PathSeparator) + ".."} {
		t.Setenv("LINGER_COMPUTER_DATA_DIR", value)
		if err := validateDataRootOverride(root); err != nil {
			t.Fatalf("equivalent root %q rejected: %v", value, err)
		}
	}
	if runtime.GOOS == "windows" {
		t.Setenv("LINGER_COMPUTER_DATA_DIR", strings.ToUpper(root))
		if err := validateDataRootOverride(root); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDispatcherRunsTheOnlyEnvironmentAndListsSeveral(t *testing.T) {
	root, _, launcher := fixture(t)
	bin := filepath.Dir(launcher)
	dispatcher := filepath.Join(bin, "linger-computer.exe")
	if err := privatefs.WriteFile(dispatcher, []byte("fixture"), true); err != nil {
		t.Fatal(err)
	}
	target, err := resolveTarget(dispatcher)
	if err != nil || target.dataRoot != root || target.launcher != launcher || target.command != "linger-computer-ci" {
		t.Fatalf("dispatched target: %+v, %v", target, err)
	}

	if err := privatefs.WriteFile(filepath.Join(root, "web-origin"), []byte("https://ci-linger.example.test\n"), true); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(bin, "linger-computer-staging.exe")
	if err := privatefs.WriteFile(other, []byte("fixture"), true); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(launcherConfig{SchemaVersion: 1, DataRoot: filepath.Join(t.TempDir(), "other")})
	if err := privatefs.WriteFile(filepath.Join(bin, "linger-computer-staging.launcher.json"), config, true); err != nil {
		t.Fatal(err)
	}
	var dispatched dispatchError
	if _, err := resolveTarget(dispatcher); !errors.As(err, &dispatched) || dispatched.code != 2 ||
		dispatched.message != "Linger Computer is installed for 2 environments on this computer. Run the command of the environment you mean:\n  linger-computer-ci                 https://ci-linger.example.test\n  linger-computer-staging            " {
		t.Fatalf("several environments: %#v", err)
	}

	for _, file := range []string{launcher, other} {
		if err := os.Remove(file); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := resolveTarget(dispatcher); !errors.As(err, &dispatched) || dispatched.code != 1 {
		t.Fatalf("no environment: %#v", err)
	}
}
