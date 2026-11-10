//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/control"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winprocess"
	localprocess "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

// platformRequest is one request of the Windows installer helper. Node cannot
// apply owner-only ACLs or read Windows process identity, so the helper asks
// the Daemon binary of the bundle it installs.
type platformRequest struct {
	Action         string   `json:"action"`
	Path           string   `json:"path,omitempty"`
	Paths          []string `json:"paths,omitempty"`
	Data           string   `json:"data,omitempty"`
	Kind           string   `json:"kind,omitempty"`
	OwnerOnly      *bool    `json:"ownerOnly,omitempty"`
	Exclusive      bool     `json:"exclusive,omitempty"`
	MaxBytes       int64    `json:"maxBytes,omitempty"`
	PID            int      `json:"pid,omitempty"`
	StateDirectory string   `json:"stateDirectory,omitempty"`
}

func runPlatform(input io.Reader, output io.Writer) error {
	decoder := json.NewDecoder(io.LimitReader(input, 16*1024*1024+1))
	decoder.DisallowUnknownFields()
	var request platformRequest
	if err := decoder.Decode(&request); err != nil {
		return errors.New("invalid platform request")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errors.New("platform request must be one JSON object")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	response, err := platformAction(ctx, request)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(response)
}

func platformAction(ctx context.Context, request platformRequest) (any, error) {
	switch request.Action {
	case "read-private-file":
		if request.MaxBytes < 0 || request.MaxBytes > 16*1024*1024 {
			return nil, errors.New("invalid private file size limit")
		}
		data, err := privatefs.ReadFile(request.Path, request.MaxBytes)
		return map[string]any{"data": string(data)}, err
	case "write-private-file":
		return map[string]any{}, privatefs.WriteFile(request.Path, []byte(request.Data), request.Exclusive)
	case "ensure-private-directory":
		return map[string]any{}, privatefs.EnsureDir(request.Path)
	case "protect-private-directories":
		// Desktop runs this before it writes the daemon config, so files an
		// earlier version left with inherited profile ACEs are repaired.
		for _, path := range request.Paths {
			if !filepath.IsAbs(path) {
				return nil, errors.New("private directory must be absolute")
			}
			if err := privatefs.ProtectDirectory(path); err != nil {
				return nil, err
			}
		}
		return map[string]any{}, nil
	case "check-private-path":
		ownerOnly := true
		if request.OwnerOnly != nil {
			ownerOnly = *request.OwnerOnly
		}
		return map[string]any{}, privatefs.CheckPath(request.Path, request.Kind, ownerOnly)
	case "check-private-paths":
		// One process checks a whole bundle; a process per file costs the
		// installer about 0.2 seconds each.
		for _, path := range request.Paths {
			if err := privatefs.CheckPath(path, request.Kind, true); err != nil {
				return nil, err
			}
		}
		return map[string]any{}, nil
	case "inspect-process":
		identity, err := winprocess.Inspect(request.PID)
		return map[string]any{"identity": identity}, err
	case "cleanup-owned-processes":
		found, err := control.StopOwner(ctx, request.StateDirectory)
		return map[string]any{"found": found}, err
	case "owned-processes-stopped":
		stopped, err := control.OwnerStopped(ctx, request.StateDirectory)
		return map[string]any{"stopped": stopped}, err
	case "stop-managed-services":
		return stopManagedServices(ctx, request.StateDirectory)
	default:
		return nil, errors.New("unknown platform action")
	}
}

func stopManagedServices(ctx context.Context, stateDirectory string) (any, error) {
	if !filepath.IsAbs(stateDirectory) {
		return nil, errors.New("state directory must be absolute")
	}
	if err := privatefs.CheckPath(stateDirectory, "directory", true); errors.Is(err, os.ErrNotExist) {
		return map[string]any{"stopped": true}, nil
	} else if err != nil {
		return nil, err
	}
	registry, err := localprocess.NewManagedServiceRegistry(stateDirectory, nil)
	if err != nil {
		return nil, err
	}
	services, err := registry.List(ctx)
	if err != nil {
		return nil, err
	}
	for _, service := range services {
		if _, err := registry.Stop(ctx, service.Name); err != nil {
			return nil, err
		}
	}
	remaining, err := registry.List(ctx)
	return map[string]any{"stopped": len(remaining) == 0}, err
}

func platformEntry(args []string) (bool, error) {
	switch {
	case len(args) == 1 && args[0] == "platform":
		return true, runPlatform(os.Stdin, os.Stdout)
	case len(args) == 1 && args[0] == "supervise-service":
		return true, localprocess.SuperviseManagedService(os.Stdin, os.Stdout)
	}
	return false, nil
}
