//go:build windows

package process

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf16"
)

// prepareScriptLauncher adapts Windows script launchers at the one process
// boundary.
func prepareScriptLauncher(cmd *exec.Cmd) {
	if cmd.Err != nil {
		return
	}
	extension := strings.ToLower(filepath.Ext(cmd.Path))
	if extension != ".cmd" && extension != ".bat" && extension != ".ps1" {
		return
	}
	if native := npmNativeEntry(cmd.Path); native != "" {
		cmd.Path = native
		cmd.Args = append([]string{native}, cmd.Args[1:]...)
		return
	}
	if node, script := npmEntry(cmd.Path, cmd.Env); node != "" {
		cmd.Path = node
		cmd.Args = append([]string{node, script}, cmd.Args[1:]...)
		return
	}
	if extension == ".cmd" || extension == ".bat" {
		companion := strings.TrimSuffix(cmd.Path, filepath.Ext(cmd.Path)) + ".ps1"
		if info, err := os.Stat(companion); err == nil && info.Mode().IsRegular() {
			cmd.Path = companion
			extension = ".ps1"
		}
	}
	if extension == ".ps1" {
		host, err := lookPath("pwsh.exe", cmd.Env)
		if err != nil {
			host, err = lookPath("powershell.exe", cmd.Env)
		}
		if err != nil {
			cmd.Err = err
			return
		}
		payload, _ := json.Marshal(struct {
			Path string   `json:"path"`
			Args []string `json:"args"`
		}{cmd.Path, cmd.Args[1:]})
		encoded := base64.StdEncoding.EncodeToString(payload)
		script := `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$PSNativeCommandArgumentPassing='Standard';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('` + encoded + `'))|ConvertFrom-Json;$a=@($p.args);& $p.path @a;if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}`
		units := utf16.Encode([]rune(script))
		data := make([]byte, len(units)*2)
		for i, v := range units {
			binary.LittleEndian.PutUint16(data[2*i:], v)
		}
		cmd.Path = host
		cmd.Args = []string{host, "-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(data)}
		return
	}
	host := environmentValue(cmd.Env, "ComSpec")
	if host == "" {
		host = filepath.Join(environmentValue(cmd.Env, "SystemRoot"), "System32", "cmd.exe")
	}
	// A batch launcher expands %* once more. Escape metacharacters at both
	// parsing boundaries; prompts themselves use the Runtime's stdin protocol.
	values := make([]string, 0, len(cmd.Args))
	values = append(values, escapeBatchMeta(cmd.Path))
	for _, value := range cmd.Args[1:] {
		if strings.ContainsAny(value, "\r\n") {
			cmd.Err = errors.New("batch launcher cannot preserve multiline argv; configure its native executable or PowerShell launcher")
			return
		}
		values = append(values, escapeBatchMeta(escapeBatchMeta(quoteWindowsArgument(value))))
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CmdLine = syscall.EscapeArg(host) + ` /d /s /v:off /c "` + strings.Join(values, " ") + `"`
	cmd.Path = host
	cmd.Args = []string{host}
}

// Batch forwarding adds a second cmd parsing boundary after %* expansion.
// Quote before escaping so embedded quotes and trailing backslashes reach the
// eventual native child's CommandLineToArgvW parser unchanged.
func quoteWindowsArgument(value string) string {
	var result strings.Builder
	result.WriteByte('"')
	slashes := 0
	for _, r := range value {
		if r == '\\' {
			slashes++
			continue
		}
		if r == '"' {
			result.WriteString(strings.Repeat("\\", 2*slashes+1))
		} else {
			result.WriteString(strings.Repeat("\\", slashes))
		}
		slashes = 0
		result.WriteRune(r)
	}
	result.WriteString(strings.Repeat("\\", 2*slashes))
	result.WriteByte('"')
	return result.String()
}
func escapeBatchMeta(value string) string {
	var result strings.Builder
	for _, r := range value {
		if strings.ContainsRune("()[]%!^\"`<>&|;, *?", r) {
			result.WriteByte('^')
		}
		result.WriteRune(r)
	}
	return result.String()
}

// Official npm launchers have fixed entry points. Starting Node directly
// preserves every argv and stdin byte, including JSON, quotes and newlines.
func npmEntry(path string, environment []string) (string, string) {
	base := strings.ToLower(strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)))
	relative := map[string]string{"codex": "@openai/codex/bin/codex.js", "claude": "@anthropic-ai/claude-code/cli.js"}[base]
	if relative == "" {
		return "", ""
	}
	script := npmPackageEntry(path, relative)
	if script == "" {
		return "", ""
	}
	node := filepath.Join(filepath.Dir(path), "node.exe")
	if info, err := os.Stat(node); err == nil && info.Mode().IsRegular() {
		return node, script
	}
	node, err := lookPath("node.exe", environment)
	if err != nil {
		return "", ""
	}
	return node, script
}

func npmNativeEntry(path string) string {
	if !strings.EqualFold(strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)), "claude") {
		return ""
	}
	return npmPackageEntry(path, "@anthropic-ai/claude-code/bin/claude.exe")
}

func npmPackageEntry(launcher, relative string) string {
	root := filepath.Join(filepath.Dir(launcher), "node_modules")
	if strings.EqualFold(filepath.Base(filepath.Dir(launcher)), ".bin") {
		root = filepath.Dir(filepath.Dir(launcher))
	}
	entry := filepath.Join(root, filepath.FromSlash(relative))
	if info, err := os.Stat(entry); err == nil && info.Mode().IsRegular() {
		return entry
	}
	return ""
}

func environmentValue(environment []string, name string) string {
	if environment == nil {
		return os.Getenv(name)
	}
	for _, entry := range environment {
		if key, value, ok := strings.Cut(entry, "="); ok && strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}
func lookPath(name string, environment []string) (string, error) {
	if environment == nil {
		return exec.LookPath(name)
	}
	for _, directory := range filepath.SplitList(environmentValue(environment, "PATH")) {
		if !filepath.IsAbs(directory) {
			continue
		}
		candidate := filepath.Join(directory, name)
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			return candidate, nil
		}
	}
	return "", &exec.Error{Name: name, Err: exec.ErrNotFound}
}
