package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

type Controller interface {
	Status(context.Context) (map[string]any, error)
	Runtimes(context.Context) (any, error)
	Runners(context.Context) (any, error)
	Runner(context.Context, string) (any, bool, error)
	StopRunner(context.Context, string) (any, bool, error)
	Services(context.Context) (any, error)
	StartService(context.Context, ServiceStart) (any, bool, error)
	StopService(context.Context, string) (any, bool, error)
	Shutdown()
	ShutdownIfIdle() int
}

type ServiceStart struct {
	Name    string   `json:"name"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Cwd     string   `json:"cwd"`
}

type Server struct {
	socketPath string
	controller Controller
	server     *http.Server
	listener   net.Listener
}

func New(stateDirectory string, controller Controller) (*Server, error) {
	if controller == nil {
		return nil, errors.New("control server requires a controller")
	}
	socketPath, err := SocketPath(stateDirectory)
	if err != nil {
		return nil, err
	}
	return &Server{socketPath: socketPath, controller: controller}, nil
}

func (s *Server) handle(writer http.ResponseWriter, request *http.Request) {
	if request.ContentLength > 8192 {
		writeError(writer, http.StatusRequestEntityTooLarge, "payload_too_large", "Control request is too large")
		return
	}
	ctx := request.Context()
	switch request.URL.Path {
	case "/status":
		if request.Method != http.MethodGet {
			writeMethod(writer)
			return
		}
		if !requireEmptyBody(writer, request) {
			return
		}
		data, err := s.controller.Status(ctx)
		writeResult(writer, data, err)
	case "/runtimes":
		if request.Method != http.MethodGet {
			writeMethod(writer)
			return
		}
		if !requireEmptyBody(writer, request) {
			return
		}
		data, err := s.controller.Runtimes(ctx)
		writeResult(writer, data, err)
	case "/runners":
		if request.Method != http.MethodGet {
			writeMethod(writer)
			return
		}
		if !requireEmptyBody(writer, request) {
			return
		}
		data, err := s.controller.Runners(ctx)
		writeResult(writer, data, err)
	case "/services":
		if request.Method == http.MethodGet {
			if !requireEmptyBody(writer, request) {
				return
			}
			data, err := s.controller.Services(ctx)
			writeResult(writer, data, err)
			return
		}
		if request.Method != http.MethodPost {
			writeMethod(writer)
			return
		}
		input, ok := readServiceStart(writer, request)
		if !ok {
			return
		}
		data, started, err := s.controller.StartService(ctx, input)
		if err != nil {
			writeResult(writer, nil, err)
			return
		}
		if !started {
			writeError(writer, http.StatusConflict, "service_already_running", "Managed service is already running")
			return
		}
		writeResult(writer, data, nil)
	case "/shutdown":
		if request.Method != http.MethodPost {
			writeMethod(writer)
			return
		}
		if !requireEmptyBody(writer, request) {
			return
		}
		writeResult(writer, map[string]any{"accepted": true}, nil)
		go s.controller.Shutdown()
	case "/shutdown-if-idle":
		if request.Method != http.MethodPost {
			writeMethod(writer)
			return
		}
		if !requireEmptyBody(writer, request) {
			return
		}
		if active := s.controller.ShutdownIfIdle(); active > 0 {
			writeError(writer, http.StatusConflict, "operations_active", fmt.Sprintf("Cannot stop while %d Agent Operations are active", active))
			return
		}
		writeResult(writer, map[string]any{"accepted": true}, nil)
		go s.controller.Shutdown()
	default:
		s.handleDynamic(writer, request)
	}
}

func (s *Server) handleDynamic(writer http.ResponseWriter, request *http.Request) {
	ctx := request.Context()
	if name, ok := dynamicPath(request.URL.Path, "/services/", "/stop"); ok {
		if request.Method != http.MethodPost {
			writeMethod(writer)
			return
		}
		if !requireEmptyBody(writer, request) {
			return
		}
		data, found, err := s.controller.StopService(ctx, name)
		if err != nil {
			writeResult(writer, nil, err)
		} else if !found {
			writeError(writer, http.StatusNotFound, "service_not_found", "Managed service not found")
		} else {
			writeResult(writer, data, nil)
		}
		return
	}
	if agentID, ok := dynamicPath(request.URL.Path, "/runners/", "/stop"); ok {
		if request.Method != http.MethodPost {
			writeMethod(writer)
			return
		}
		if !requireEmptyBody(writer, request) {
			return
		}
		data, found, err := s.controller.StopRunner(ctx, agentID)
		if err != nil {
			writeResult(writer, nil, err)
		} else if !found {
			writeError(writer, http.StatusNotFound, "runner_not_found", "Runner not found")
		} else {
			writeResult(writer, data, nil)
		}
		return
	}
	if agentID, ok := dynamicPath(request.URL.Path, "/runners/", ""); ok {
		if request.Method != http.MethodGet {
			writeMethod(writer)
			return
		}
		if !requireEmptyBody(writer, request) {
			return
		}
		data, found, err := s.controller.Runner(ctx, agentID)
		if err != nil {
			writeResult(writer, nil, err)
		} else if !found {
			writeError(writer, http.StatusNotFound, "runner_not_found", "Runner not found")
		} else {
			writeResult(writer, data, nil)
		}
		return
	}
	writeError(writer, http.StatusNotFound, "not_found", "Control route not found")
}

func dynamicPath(path, prefix, suffix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return "", false
	}
	encoded := strings.TrimSuffix(strings.TrimPrefix(path, prefix), suffix)
	if encoded == "" || strings.Contains(encoded, "/") {
		return "", false
	}
	value, err := url.PathUnescape(encoded)
	return value, err == nil && value != "" && !strings.Contains(value, "/")
}

func requireEmptyBody(writer http.ResponseWriter, request *http.Request) bool {
	body, err := io.ReadAll(io.LimitReader(request.Body, 8193))
	if err != nil {
		writeError(writer, http.StatusBadRequest, "bad_request", "Invalid control request")
		return false
	}
	if len(body) > 8192 {
		writeError(writer, http.StatusRequestEntityTooLarge, "payload_too_large", "Control request is too large")
		return false
	}
	if len(body) != 0 {
		writeError(writer, http.StatusBadRequest, "bad_request", "Control request body must be empty")
		return false
	}
	return true
}

func readServiceStart(writer http.ResponseWriter, request *http.Request) (ServiceStart, bool) {
	body, err := io.ReadAll(io.LimitReader(request.Body, 8193))
	if err != nil || len(body) == 0 {
		writeError(writer, http.StatusBadRequest, "bad_request", "Invalid control request")
		return ServiceStart{}, false
	}
	if len(body) > 8192 {
		writeError(writer, http.StatusRequestEntityTooLarge, "payload_too_large", "Control request is too large")
		return ServiceStart{}, false
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	var input ServiceStart
	if decoder.Decode(&input) != nil {
		writeError(writer, http.StatusBadRequest, "bad_request", "Invalid control request")
		return ServiceStart{}, false
	}
	return input, true
}

func writeMethod(writer http.ResponseWriter) {
	writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
}

func writeResult(writer http.ResponseWriter, data any, err error) {
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "internal_error", "Control request failed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"version": 1, "ok": true, "data": data})
}

func writeError(writer http.ResponseWriter, status int, code, message string) {
	writeJSON(writer, status, map[string]any{"version": 1, "ok": false, "error": map[string]any{"code": code, "message": message}})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		writer.WriteHeader(http.StatusInternalServerError)
		return
	}
	writer.Header().Set("content-type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write(encoded)
}
