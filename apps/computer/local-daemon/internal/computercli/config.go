package computercli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const maxConfigBytes = 1024 * 1024

// loadStateDirectory reads only the state directory, which locates the
// Daemon's control endpoint, without validating the credential.
func loadStateDirectory(configPath string) (string, error) {
	value, err := readConfigObject(configPath)
	if err != nil {
		return "", err
	}
	directory, _ := value["state_directory"].(string)
	if !filepath.IsAbs(directory) {
		return "", &configError{message: "state_directory must be an absolute path"}
	}
	return directory, nil
}

func readConfigObject(configPath string) (map[string]any, error) {
	encoded, err := privatefs.ReadFile(configPath, maxConfigBytes)
	if errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err != nil {
		return nil, &configError{message: "Computer config file is unsafe"}
	}
	var value any
	if json.Unmarshal(encoded, &value) != nil {
		return nil, &configError{message: "Computer config is not valid JSON"}
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, &configError{message: "Computer config must be an object"}
	}
	return object, nil
}

// computerIdentity is what auth status shows about the saved enrollment.
type computerIdentity struct {
	computerID          string
	credentialExpiresAt string
	displayName         string
	gatewayURL          string
	tenantID            string
}

// configInspection is a tolerant reading of the config for diagnostics: it
// reports problems as checks instead of failing.
type configInspection struct {
	configCheck     doctorCheck
	credentialCheck doctorCheck
	enrollmentCheck *doctorCheck
	identity        *computerIdentity
	runtimePaths    map[string]string
	enabledRuntimes []string
	codexHome       string
	gatewayURL      string
	stateDirectory  string
}

func inspectComputerConfig(configPath string, environment map[string]string, commandName string) configInspection {
	inspection, err := readInspection(configPath, environment, commandName)
	if err != nil {
		return configInspection{
			configCheck:     doctorCheck{Name: "config", Category: categoryConfiguration, Status: "fail", Detail: err.Error()},
			credentialCheck: failedCredential("Credential cannot be checked without a valid config"),
		}
	}
	return inspection
}

func readInspection(configPath string, environment map[string]string, commandName string) (configInspection, error) {
	if err := checkPrivateFile(configPath); err != nil {
		return configInspection{}, err
	}
	encoded, err := privatefs.ReadFile(configPath, maxConfigBytes)
	if err != nil {
		return configInspection{}, err
	}
	var decoded any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return configInspection{}, errors.New("Config is not valid JSON")
	}
	value, ok := decoded.(map[string]any)
	if !ok {
		return configInspection{}, errors.New("Config must be an object")
	}
	stateDirectory := stringField(value, "state_directory")
	if !filepath.IsAbs(stateDirectory) {
		return configInspection{}, errors.New("Config must include an absolute state_directory")
	}
	gatewayURL, err := readGatewayURL(value["gateway"])
	if err != nil {
		return configInspection{}, err
	}
	credentialCheck := inspectCredential(value["gateway"], environment, value["credential_expires_at"])
	enrollmentCheck := inspectEnrollment(value, gatewayURL, commandName)
	codexAuthFile := ""
	if codex, ok := value["codex"].(map[string]any); ok {
		codexAuthFile = stringField(codex, "auth_file")
	}
	if codexAuthFile != "" && !filepath.IsAbs(codexAuthFile) {
		return configInspection{}, errors.New("codex.auth_file must be an absolute path")
	}
	inspection := configInspection{
		configCheck:     doctorCheck{Name: "config", Category: categoryConfiguration, Status: "pass", Detail: configPath},
		credentialCheck: credentialCheck,
		enrollmentCheck: &enrollmentCheck,
		identity: &computerIdentity{
			computerID: stringField(value, "runner_id"), displayName: stringField(value, "display_name"),
			gatewayURL: gatewayURL, tenantID: firstTenantID(value),
		},
		gatewayURL: gatewayURL, stateDirectory: stateDirectory,
		runtimePaths: readRuntimePaths(value["runtime_paths"]),
	}
	if expiry, ok := value["credential_expires_at"].(string); ok {
		inspection.identity.credentialExpiresAt = expiry
	}
	if selection, present := value["enabled_runtimes"]; present {
		if inspection.enabledRuntimes, err = readEnabledRuntimes(selection); err != nil {
			return configInspection{}, err
		}
	}
	if codexAuthFile != "" {
		inspection.codexHome = filepath.Dir(codexAuthFile)
	}
	return inspection, nil
}

func readEnabledRuntimes(value any) ([]string, error) {
	items, ok := value.([]any)
	types := make([]string, 0, len(items))
	for _, item := range items {
		text, isText := item.(string)
		if !isText {
			ok = false
		}
		types = append(types, text)
	}
	if !ok || !validRuntimeSelection(types) {
		return nil, errors.New("enabled_runtimes must be a nonempty unique subset of codex, claude, pi")
	}
	return types, nil
}

func inspectEnrollment(config map[string]any, gatewayURL, commandName string) doctorCheck {
	computerID := stringField(config, "runner_id")
	if computerID == "" {
		computerID = "unknown"
	}
	tenantID := firstTenantID(config)
	if tenantID == "" {
		tenantID = "unknown"
	}
	detail := fmt.Sprintf("computer_id=%s tenant_id=%s gateway=%s", computerID, tenantID, gatewayURL)
	parsed, _ := url.Parse(gatewayURL)
	if host := parsed.Hostname(); host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return doctorCheck{
			Name: "enrollment", Category: categoryConfiguration, Status: "warn",
			Detail: fmt.Sprintf("%s; this Gateway is local to the current machine. If the Agent Service is on another host, run %s doctor --prune, then %s login", detail, commandName, commandName),
		}
	}
	return doctorCheck{Name: "enrollment", Category: categoryConfiguration, Status: "pass", Detail: detail}
}

func firstTenantID(config map[string]any) string {
	grants, _ := config["workspace_grants"].([]any)
	for _, grant := range grants {
		if value, ok := grant.(map[string]any); ok {
			return stringField(value, "tenant_id")
		}
	}
	return ""
}

func inspectCredential(gatewayValue any, environment map[string]string, credentialExpiresAt any) doctorCheck {
	gateway, ok := gatewayValue.(map[string]any)
	if !ok {
		return failedCredential("Config gateway is missing")
	}
	tokenFile := stringField(gateway, "token_file")
	tokenEnvironment := stringField(gateway, "token_env")
	if (tokenFile == "") == (tokenEnvironment == "") {
		return failedCredential("Gateway must configure exactly one credential source")
	}
	if credentialExpiresAt != nil {
		text, isText := credentialExpiresAt.(string)
		if _, err := time.Parse(time.RFC3339Nano, text); !isText || err != nil {
			return failedCredential("Gateway credential metadata is invalid")
		}
	}
	if tokenEnvironment != "" {
		if environment[tokenEnvironment] != "" {
			return doctorCheck{Name: "credential", Category: categoryCredential, Status: "pass", Detail: "Environment " + tokenEnvironment + " is set"}
		}
		return failedCredential("Environment " + tokenEnvironment + " is not set")
	}
	if !filepath.IsAbs(tokenFile) {
		return failedCredential("Gateway credential path must be absolute")
	}
	content, err := privatefs.ReadFile(tokenFile, 4096)
	token := strings.TrimSpace(string(content))
	if err != nil || token == "" || strings.IndexFunc(token, unicode.IsSpace) != -1 {
		return failedCredential("Gateway credential file is unavailable or has unsafe permissions")
	}
	return doctorCheck{Name: "credential", Category: categoryCredential, Status: "pass", Detail: "Owner-only credential file is readable"}
}

// checkPrivateFile requires an owner-only, single-link regular file.
func checkPrivateFile(path string) error {
	err := privatefs.CheckPath(path, "file", true)
	if err == nil || errors.Is(err, os.ErrNotExist) {
		return err
	}
	return fmt.Errorf("%s must be an owner-only regular file", path)
}

func readRuntimePaths(value any) map[string]string {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	var paths map[string]string
	for _, runtimeType := range runtimeTypes {
		if executable := stringField(object, runtimeType); executable != "" {
			if paths == nil {
				paths = map[string]string{}
			}
			paths[runtimeType] = executable
		}
	}
	return paths
}

func readGatewayURL(gatewayValue any) (string, error) {
	gateway, ok := gatewayValue.(map[string]any)
	if !ok {
		return "", errors.New("Config gateway is missing")
	}
	parsed, err := url.Parse(stringField(gateway, "url"))
	if err != nil || parsed.Host == "" {
		return "", errors.New("Gateway URL is invalid")
	}
	if (parsed.Scheme != "ws" && parsed.Scheme != "wss") || parsed.User != nil {
		return "", errors.New("Gateway URL must use ws or wss without credentials")
	}
	return normalizedURL(parsed), nil
}

// normalizedURL writes a URL with an explicit root path, as WHATWG URLs do.
func normalizedURL(value *url.URL) string {
	copied := *value
	if copied.Path == "" {
		copied.Path = "/"
	}
	return copied.String()
}

func failedCredential(detail string) doctorCheck {
	return doctorCheck{Name: "credential", Category: categoryCredential, Status: "fail", Detail: detail}
}

func stringField(value map[string]any, key string) string {
	text, _ := value[key].(string)
	return text
}
