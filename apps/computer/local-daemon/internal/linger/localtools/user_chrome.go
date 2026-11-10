package localtools

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// childEnvironmentKeys are the only variables browser and desktop children
// inherit. Windows needs its folder variables: Playwright locates chrome.exe
// and Node resolves system paths through them.
var childEnvironmentKeys = []string{"HOME", "USER", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "XDG_RUNTIME_DIR",
	"DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE",
	"USERPROFILE", "USERNAME", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA",
	"SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "HOMEDRIVE", "HOMEPATH"}

func childEnvironment(source map[string]string) []string {
	var result []string
	for _, key := range childEnvironmentKeys {
		for name, value := range source {
			// Windows variable names are case-insensitive: ProgramFiles, Path.
			if value != "" && (name == key || (runtime.GOOS == "windows" && strings.EqualFold(name, key))) {
				result = append(result, name+"="+value)
				break
			}
		}
	}
	return result
}

func environmentValue(env []string, key string) string {
	for _, entry := range env {
		name, value, _ := strings.Cut(entry, "=")
		if name == key || (runtime.GOOS == "windows" && strings.EqualFold(name, key)) {
			return value
		}
	}
	return ""
}

// chromeExecutable returns the installed Google Chrome. The Agent profile and
// the extension connection both use it; neither downloads a browser.
func chromeExecutable(env []string) string {
	var candidates []string
	switch runtime.GOOS {
	case "linux":
		// Snap Chromium comes before /usr/bin/chromium-browser, which on Ubuntu
		// is a script that runs it, so its confined profile folder is chosen.
		candidates = []string{"/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/snap/bin/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser"}
		for _, folder := range filepath.SplitList(environmentValue(env, "PATH")) {
			for _, name := range []string{"google-chrome-stable", "google-chrome", "chromium", "chromium-browser"} {
				if filepath.IsAbs(folder) {
					candidates = append(candidates, filepath.Join(folder, name))
				}
			}
		}
	case "darwin":
		candidates = []string{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
		if home := environmentValue(env, "HOME"); home != "" {
			candidates = append(candidates, filepath.Join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
		}
	case "windows":
		for _, root := range []string{"LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"} {
			if base := environmentValue(env, root); base != "" {
				candidates = append(candidates, filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"))
			}
		}
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			return candidate
		}
	}
	return ""
}

func chromeUserDataDirectory(env []string) string {
	switch runtime.GOOS {
	case "darwin":
		if home := environmentValue(env, "HOME"); home != "" {
			return filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
		}
	case "windows":
		if local := environmentValue(env, "LOCALAPPDATA"); local != "" {
			return filepath.Join(local, "Google", "Chrome", "User Data")
		}
	}
	return ""
}

type userChromeInstall struct{ executable, profile string }

// findUserChrome resolves the Chrome profile with the Playwright Extension.
// The extension token belongs to one profile; Chrome opens the connect page
// in exactly that profile.
func findUserChrome(env []string, requested string) (userChromeInstall, error) {
	executable := chromeExecutable(env)
	if executable == "" {
		return userChromeInstall{}, &BrowserCommandError{"BROWSER_UNAVAILABLE", "install Google Chrome to connect the everyday browser", false}
	}
	data := chromeUserDataDirectory(env)
	installed := func(profile string) bool {
		info, err := os.Stat(filepath.Join(data, profile, "Extensions", playwrightExtensionID))
		return err == nil && info.IsDir()
	}
	if requested != "" {
		if !installed(requested) {
			return userChromeInstall{}, &BrowserCommandError{"BROWSER_EXTENSION_UNAVAILABLE", "install the Playwright Extension in the Chrome profile " + requested, false}
		}
		return userChromeInstall{executable, requested}, nil
	}
	var state struct {
		Profile struct {
			LastUsed string `json:"last_used"`
		} `json:"profile"`
	}
	if encoded, err := os.ReadFile(filepath.Join(data, "Local State")); err == nil {
		_ = json.Unmarshal(encoded, &state)
	}
	candidates := []string{state.Profile.LastUsed, "Default"}
	if entries, err := os.ReadDir(data); err == nil {
		for _, entry := range entries {
			candidates = append(candidates, entry.Name())
		}
	}
	for _, profile := range candidates {
		if chromeProfilePattern.MatchString(profile) && installed(profile) {
			return userChromeInstall{executable, profile}, nil
		}
	}
	return userChromeInstall{}, &BrowserCommandError{"BROWSER_EXTENSION_UNAVAILABLE", "install the Playwright Extension in Chrome, then copy its token", false}
}

// defaultBrowserNote names a non-Chromium default browser. Its sign-ins cannot
// be reused; browser tools keep the dedicated Agent Chrome.
func defaultBrowserNote(env []string) string {
	name := defaultBrowserName(env)
	if name == "" || name == "chrome" || name == "chromium" {
		return ""
	}
	return "The default browser (" + name + ") cannot be connected; Agents use their own Chrome, which does not have the user's sign-ins."
}

func defaultBrowserName(env []string) string {
	switch runtime.GOOS {
	case "darwin":
		home := environmentValue(env, "HOME")
		if home == "" {
			return ""
		}
		output, err := exec.Command("/usr/bin/plutil", "-convert", "json", "-o", "-", filepath.Join(home, "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist")).Output()
		if err != nil {
			return ""
		}
		var handlers struct {
			LSHandlers []struct {
				Scheme string `json:"LSHandlerURLScheme"`
				Role   string `json:"LSHandlerRoleAll"`
			} `json:"LSHandlers"`
		}
		if json.Unmarshal(output, &handlers) != nil {
			return ""
		}
		for _, handler := range handlers.LSHandlers {
			if handler.Scheme == "https" {
				return browserFamily(handler.Role)
			}
		}
	case "windows":
		return browserFamily(windowsDefaultBrowserProgID())
	}
	return ""
}

func browserFamily(identifier string) string {
	value := strings.ToLower(identifier)
	switch {
	case value == "":
		return ""
	case strings.Contains(value, "chrome"):
		return "chrome"
	case strings.Contains(value, "chromium"):
		return "chromium"
	case strings.Contains(value, "safari"):
		return "Safari"
	case strings.Contains(value, "firefox"):
		return "Firefox"
	case strings.Contains(value, "edge"), strings.HasPrefix(value, "msedge"):
		return "Microsoft Edge"
	case strings.Contains(value, "brave"):
		return "Brave"
	case strings.Contains(value, "arc"):
		return "Arc"
	}
	return identifier
}
