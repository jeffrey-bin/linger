package computerconfig

import (
	"os"
	"runtime"
	"strings"
)

// ProcessEnvironment returns the current environment. Windows keys are upper
// case because Windows variable names are case-insensitive.
func ProcessEnvironment() map[string]string {
	result := make(map[string]string)
	for _, entry := range os.Environ() {
		if index := strings.IndexByte(entry, '='); index > 0 {
			key := entry[:index]
			if runtime.GOOS == "windows" {
				key = strings.ToUpper(key)
			}
			result[key] = entry[index+1:]
		}
	}
	if runtime.GOOS == "windows" && result["HOME"] == "" {
		result["HOME"], _ = os.UserHomeDir()
	}
	return result
}

// RuntimeEnvironment keeps the user's own variables for a Runtime: Linger
// control state and any value equal to the Gateway credential never reach it.
func RuntimeEnvironment(source map[string]string, gatewayToken string) map[string]string {
	result := make(map[string]string)
	for key, value := range source {
		upperKey := strings.ToUpper(key)
		if (gatewayToken != "" && value == gatewayToken) || strings.HasPrefix(upperKey, "LINGER_") || strings.HasPrefix(upperKey, "RUNNER_GATEWAY_") || strings.HasPrefix(upperKey, "MIRROR_") || strings.HasPrefix(upperKey, "TEAMHUB_") || upperKey == "SERVICE_TOKEN" {
			continue
		}
		result[key] = value
	}
	return result
}
