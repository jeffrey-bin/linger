//go:build windows

package privatefs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func TestWindowsAncestorDeleteRightsRespectVolumeRoot(t *testing.T) {
	sid, err := CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name       string
		access     string
		volumeRoot bool
		allowed    bool
	}{
		{"default volume root modify", "0x1301bf", true, true},
		{"replaceable ordinary ancestor", "0x1301bf", false, false},
		{"root child deletion", "0x40", true, false},
		{"root ACL changes", "WD", true, false},
		{"root ownership changes", "WO", true, false},
		{"root all access", "GA", true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			sd, err := windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;;FA;;;" + sid.String() + ")(A;;" + test.access + ";;;AU)")
			if err != nil {
				t.Fatal(err)
			}
			err = validateAncestorDescriptor(sd, test.volumeRoot)
			if (err == nil) != test.allowed {
				t.Fatalf("allowed = %v, error = %v", test.allowed, err)
			}
		})
	}
}

func TestWindowsACLRejectsOtherUserWriteAndPrivateRead(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "config.json")
	if err := WriteFile(path, []byte("secret"), true); err != nil {
		t.Fatal(err)
	}
	sid, err := CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	set := func(access string) {
		t.Helper()
		sd, err := windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;;FA;;;" + sid.String() + ")(A;;" + access + ";;;WD)")
		if err != nil {
			t.Fatal(err)
		}
		acl, _, err := sd.DACL()
		if err != nil {
			t.Fatal(err)
		}
		if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
			t.Fatal(err)
		}
	}
	set("FR")
	if err := CheckPath(path, "file", false); err != nil {
		t.Fatalf("public read should be safe for Skills: %v", err)
	}
	if _, err := ReadFile(path, 0); err == nil {
		t.Fatal("credential readable by Everyone accepted")
	}
	set("FW")
	if err := CheckPath(path, "file", false); err == nil {
		t.Fatal("Everyone-writable Skill accepted")
	}
}
func TestWindowsPrivatePathsRejectJunctionAncestors(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	alias := filepath.Join(root, "alias")
	if err := EnsureDir(source); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(filepath.Join(source, "secret"), []byte("secret"), true); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(alias, 0o700); err != nil {
		t.Fatal(err)
	}
	name, _ := windows.UTF16PtrFromString(alias)
	handle, err := windows.CreateFile(name, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Fatal(err)
	}
	data := winio.EncodeReparsePoint(&winio.ReparsePoint{Target: source, IsMountPoint: true})
	var returned uint32
	err = windows.DeviceIoControl(handle, windows.FSCTL_SET_REPARSE_POINT, &data[0], uint32(len(data)), nil, 0, &returned, nil)
	windows.CloseHandle(handle)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFile(filepath.Join(alias, "secret"), 0); err == nil {
		t.Fatal("junction ancestor accepted")
	}
	if err := EnsureDir(alias); err == nil {
		t.Fatal("junction protected as ordinary directory")
	}
}
func TestWindowsPrivateOpenPinsFileAgainstReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret")
	if err := WriteFile(path, []byte("first"), true); err != nil {
		t.Fatal(err)
	}
	file, err := OpenRead(path, true)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := os.Rename(path, path+".moved"); err == nil {
		t.Fatal("opened private file was replaced")
	}
}

func TestWindowsPrivateWritePreservesExistingParentPermissions(t *testing.T) {
	root := t.TempDir()
	sid, err := CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;OICI;FA;;;" + sid.String() + ")(A;OICI;FR;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	before, err := windows.GetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "credential.json")
	if err := WriteFile(path, []byte("private"), true); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("replacement"), false); err != nil {
		t.Fatal(err)
	}
	after, err := windows.GetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if before.String() != after.String() {
		t.Fatal("writing a credential changed its parent ACL")
	}
	if err := CheckPath(path, "file", true); err != nil {
		t.Fatalf("new credential is not private: %v", err)
	}
	if err := CheckPath(root, "directory", true); err == nil {
		t.Fatal("shared read access was removed from parent")
	}
}

func TestWindowsPrivateWriteRejectsReplaceableAncestor(t *testing.T) {
	root := t.TempDir()
	private := filepath.Join(root, "private")
	if err := EnsureDir(private); err != nil {
		t.Fatal(err)
	}
	sid, err := CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	// DELETE_CHILD is sufficient to replace the private directory even when
	// the child itself has a protected DACL.
	sd, err := windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;;FA;;;" + sid.String() + ")(A;;0x40;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, _ := sd.DACL()
	if err := windows.SetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(filepath.Join(private, "secret"), []byte("private"), true); err == nil {
		t.Fatal("credential published through replaceable ancestor")
	}
}

func TestWindowsOwnerOnlyDescriptor(t *testing.T) {
	sid, err := CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	user := sid.String()
	for _, test := range []struct {
		name      string
		dacl      string
		ownerOnly bool
		allowed   bool
	}{
		{"user and SYSTEM", "D:P(A;;FA;;;" + user + ")(A;;FA;;;SY)", true, true},
		{"user, SYSTEM and Administrators", "D:P(A;;FA;;;" + user + ")(A;;FA;;;SY)(A;;FA;;;BA)", true, true},
		{"inherited profile ACEs", "D:AI(A;ID;FA;;;" + user + ")(A;ID;FA;;;SY)(A;ID;FA;;;BA)", true, true},
		{"inherit-only Everyone", "D:P(A;;FA;;;" + user + ")(A;OICIIO;FA;;;WD)", true, true},
		{"denied Everyone", "D:P(A;;FA;;;" + user + ")(D;;FA;;;WD)", true, true},
		{"inherited Authenticated Users read", "D:AI(A;ID;FA;;;" + user + ")(A;ID;FR;;;AU)", true, false},
		{"Users read", "D:P(A;;FA;;;" + user + ")(A;;FR;;;BU)", true, false},
		{"Users read for public Skills", "D:P(A;;FA;;;" + user + ")(A;;FR;;;BU)", false, true},
		{"Users write for public Skills", "D:P(A;;FA;;;" + user + ")(A;;FW;;;BU)", false, false},
		{"no DACL", "", true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			sd, err := windows.SecurityDescriptorFromString("O:" + user + test.dacl)
			if err != nil {
				t.Fatal(err)
			}
			err = validateDescriptor(sd, test.ownerOnly)
			if (err == nil) != test.allowed {
				t.Fatalf("allowed = %v, error = %v", test.allowed, err)
			}
		})
	}
}

func TestWindowsCreatedDescriptorIsOwnerOnly(t *testing.T) {
	sd, err := SecurityDescriptor()
	if err != nil {
		t.Fatal(err)
	}
	if err := validateDescriptor(sd, true); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsOwnerOnlyErrorNamesTheAccount(t *testing.T) {
	sid, err := CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;;FA;;;" + sid.String() + ")(A;;FR;;;AU)")
	if err != nil {
		t.Fatal(err)
	}
	err = validateDescriptor(sd, true)
	if err == nil || !strings.Contains(err.Error(), "S-1-5-11") {
		t.Fatalf("error = %v, want the Authenticated Users SID", err)
	}
}

// Files an earlier Desktop wrote inherit the profile ACL; with a broader
// profile ACL the daemon refused its config on every start.
func TestWindowsProtectDirectoryRepairsInheritedFiles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "computer")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	sid, err := CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	broad, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + sid.String() + ")(A;OICI;FA;;;SY)(A;OICI;FR;;;AU)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := broad.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, "config.json")
	if err := os.WriteFile(config, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	explicit := filepath.Join(root, "credential.json")
	if err := os.WriteFile(explicit, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(explicit, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFile(config, 0); err == nil {
		t.Fatal("config readable by Authenticated Users accepted")
	}
	if err := ProtectDirectory(root); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{config, explicit} {
		if _, err := ReadFile(path, 0); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	if err := CheckPath(root, "directory", true); err != nil {
		t.Fatal(err)
	}
	// A file created afterwards inherits the protected DACL.
	later := filepath.Join(root, "later.json")
	if err := os.WriteFile(later, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFile(later, 0); err != nil {
		t.Fatal(err)
	}
}
