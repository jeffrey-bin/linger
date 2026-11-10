//go:build windows

package localskills

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"golang.org/x/sys/windows"
)

func TestWindowsSkillScanUsesNativeHomesAndRejectsWritableACL(t *testing.T) {
	for _, runtimeType := range []string{"codex", "claude"} {
		t.Run(runtimeType, func(t *testing.T) {
			home := filepath.Join(t.TempDir(), "Usuário Habilidade")
			root := skillRoots(home, runtimeType)[0]
			manifest := filepath.Join(root, "native-skill", "SKILL.md")
			if err := privatefs.WriteFile(manifest, []byte("---\nname: native-skill\ndescription: Contenu français é\n---\n"), true); err != nil {
				t.Fatal(err)
			}
			if err := privatefs.WriteFile(filepath.Join(root, "native-skill", "scripts", "run.ps1"), []byte("Write-Output 'Café'\n"), true); err != nil {
				t.Fatal(err)
			}
			now := time.Now()
			catalog := openTestCatalog(t, home, now)
			command := testCommand(now)
			command.RuntimeType = runtimeType
			result := handleOutcome[scannedOutcome](t, catalog, command)
			if len(result.Items) != 1 || result.Items[0].Importability != "ready" || len(result.Items[0].RiskFlags) != 2 {
				t.Fatalf("scan=%+v", result)
			}
			sid, err := privatefs.CurrentSID()
			if err != nil {
				t.Fatal(err)
			}
			sd, err := windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;;FA;;;" + sid.String() + ")(A;;FW;;;WD)")
			if err != nil {
				t.Fatal(err)
			}
			acl, _, _ := sd.DACL()
			if err := windows.SetNamedSecurityInfo(manifest, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
				t.Fatal(err)
			}
			if _, err := inspectSkill(filepath.Dir(manifest), os.Getuid()); err == nil {
				t.Fatal("Everyone-writable Skill accepted")
			}
		})
	}
}
