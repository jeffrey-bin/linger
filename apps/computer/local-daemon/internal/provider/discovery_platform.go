package provider

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func platformEnvironment(source map[string]string) map[string]string {
	if runtime.GOOS != "windows" {
		return source
	}
	result := make(map[string]string, len(source)+1)
	for key, value := range source {
		result[strings.ToUpper(key)] = value
	}
	if result["HOME"] == "" {
		result["HOME"] = result["USERPROFILE"]
	}
	if result["HOME"] == "" {
		result["HOME"], _ = os.UserHomeDir()
	}
	return result
}
func executableNames(name string) []string {
	if runtime.GOOS != "windows" || filepath.Ext(name) != "" {
		return []string{name}
	}
	return []string{name + ".exe", name + ".com", name + ".cmd", name + ".bat", name + ".ps1"}
}
func executableDirectories(pathValue string, environment map[string]string) []string {
	directories := filepath.SplitList(pathValue)
	if home := environment["HOME"]; home != "" {
		directories = append(directories, filepath.Join(home, ".local", "bin"))
	}
	if runtime.GOOS == "windows" {
		if appdata := environment["APPDATA"]; appdata != "" {
			directories = append(directories, filepath.Join(appdata, "npm"))
		}
	}
	return directories
}
