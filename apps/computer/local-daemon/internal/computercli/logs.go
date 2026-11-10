package computercli

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const maxPendingLogBytes = 64 * 1024

type logRequest struct {
	configPath string
	follow     bool
	lines      int
}

// streamComputerLogs prints the last lines of the Daemon log, redacted, and
// keeps printing new lines until ctx ends when following.
func streamComputerLogs(ctx context.Context, request logRequest, output io.Writer) error {
	logPath, err := resolveLogPath(request.configPath)
	if err != nil {
		return err
	}
	initial, err := os.ReadFile(logPath)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(output, redact(tailLines(string(initial), request.lines))); err != nil {
		return err
	}
	if !request.follow {
		return nil
	}
	offset := int64(len(initial))
	pending := ""
	defer func() {
		if pending != "" {
			_, _ = io.WriteString(output, redact(pending))
		}
	}()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
		info, err := os.Stat(logPath)
		if err != nil {
			return err
		}
		if info.Size() < offset {
			offset = 0
		}
		if info.Size() == offset {
			continue
		}
		chunk, err := readRange(logPath, offset, info.Size())
		if err != nil {
			return err
		}
		offset = info.Size()
		pending += chunk
		if newline := strings.LastIndexByte(pending, '\n'); newline >= 0 {
			if _, err := io.WriteString(output, redact(pending[:newline+1])); err != nil {
				return err
			}
			pending = pending[newline+1:]
		} else if len(pending) >= maxPendingLogBytes {
			if _, err := io.WriteString(output, redact(pending)); err != nil {
				return err
			}
			pending = ""
		}
	}
}

func readRange(path string, start, end int64) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	buffer := make([]byte, end-start)
	read, err := file.ReadAt(buffer, start)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return string(buffer[:read]), nil
}

func resolveLogPath(configPath string) (string, error) {
	root := filepath.Dir(configPath)
	preferred := filepath.Join(root, "logs", "computer.log")
	if _, err := os.Stat(preferred); err == nil {
		return preferred, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	// A failed setup removes its config, which is when the log matters most.
	// Setup always places the state directory beside the config.
	if _, err := os.Stat(configPath); errors.Is(err, os.ErrNotExist) {
		return filepath.Join(root, "state", "daemon.log"), nil
	} else if err != nil {
		return "", err
	}
	value, err := readConfigObject(configPath)
	if err != nil {
		return "", err
	}
	stateDirectory, ok := value["state_directory"].(string)
	if !ok {
		return "", errors.New("Computer config does not contain state_directory")
	}
	return filepath.Join(stateDirectory, "daemon.log"), nil
}

func tailLines(value string, lines int) string {
	parts := strings.SplitAfter(value, "\n")
	if parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > lines {
		parts = parts[len(parts)-lines:]
	}
	return strings.Join(parts, "")
}

var redactions = []struct {
	pattern     *regexp.Regexp
	replacement string
}{
	{regexp.MustCompile(`(?i)\b((?:proxy-)?authorization)\s*[:=]\s*[^\r\n]*`), "${1}: [REDACTED]"},
	{regexp.MustCompile(`(?i)\b(set-cookie|cookie)\s*[:=]\s*[^\r\n]*`), "${1}: [REDACTED]"},
	{regexp.MustCompile(`(?i)("?(?:password|passwd|token|secret|credential|api[_-]?key|private[_-]?key)"?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)`), "${1}[REDACTED]"},
	{regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9._~+/-]+`), "Bearer [REDACTED]"},
	{regexp.MustCompile(`(?i)\b(https?://)[^\s/:@]+:[^\s/@]+@`), "${1}[REDACTED]@"},
}

func redact(value string) string {
	for _, redaction := range redactions {
		value = redaction.pattern.ReplaceAllString(value, redaction.replacement)
	}
	return value
}
