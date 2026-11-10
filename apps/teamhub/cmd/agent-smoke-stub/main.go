package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

const maxRequestBytes = 1 << 20

type registrationRequest struct {
	TenantID string `json:"tenantId"`
	Revision string `json:"revision"`
	Agent    struct {
		Name         string `json:"name"`
		Instructions string `json:"instructions"`
	} `json:"agent"`
	Runtime struct {
		Model string `json:"model"`
	} `json:"runtime"`
	Resources struct {
		Skills     []json.RawMessage `json:"skills"`
		MCPServers []json.RawMessage `json:"mcpServers"`
	} `json:"resources"`
}

type requestLog struct {
	Kind           string `json:"kind"`
	Method         string `json:"method"`
	Path           string `json:"path"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
	Body           any    `json:"body"`
}

type stub struct {
	token   string
	agentID string
	logFile *os.File
	logMu   sync.Mutex
}

func main() {
	address := envOr("TEAMHUB_AGENT_SMOKE_ADDRESS", "127.0.0.1:18092")
	token := envOr("TEAMHUB_AGENT_SMOKE_TOKEN", "agent-smoke-service-token")
	agentID := envOr("TEAMHUB_AGENT_SMOKE_AGENT_ID", "agent-smoke-reviewer")
	logPath := os.Getenv("TEAMHUB_AGENT_SMOKE_LOG")
	if logPath == "" {
		log.Fatal("TEAMHUB_AGENT_SMOKE_LOG is required")
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		log.Fatal(err)
	}
	defer logFile.Close()

	handler := &stub{token: token, agentID: agentID, logFile: logFile}
	server := &http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("Agent smoke stub listening on %s", address)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			log.Fatal(err) //nolint:gocritic // the process exits; releasing the signal context and timers first is unnecessary
		}
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}
}

func (s *stub) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodGet && request.URL.Path == "/healthz" {
		writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	if request.Header.Get("Authorization") != "Bearer "+s.token {
		writeJSON(response, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}

	switch {
	case request.Method == http.MethodPost && request.URL.Path == "/v1/agents":
		s.registerAgent(response, request)
	default:
		writeJSON(response, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

func (s *stub) registerAgent(response http.ResponseWriter, request *http.Request) {
	key := request.Header.Get("Idempotency-Key")
	var body registrationRequest
	if key == "" || decodeSingleJSON(request.Body, &body) != nil || body.TenantID == "" || body.Revision != "1" || strings.TrimSpace(body.Agent.Name) == "" ||
		strings.TrimSpace(body.Agent.Instructions) == "" || strings.TrimSpace(body.Runtime.Model) == "" {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid registration"})
		return
	}
	if err := s.record(requestLog{Kind: "registration", Method: request.Method, Path: request.URL.Path, IdempotencyKey: key, Body: body}); err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]string{"error": "record request"})
		return
	}
	writeJSON(response, http.StatusCreated, map[string]string{"agentId": s.agentID, "revision": "1"})
}

func (s *stub) record(entry requestLog) error {
	s.logMu.Lock()
	defer s.logMu.Unlock()
	if err := json.NewEncoder(s.logFile).Encode(entry); err != nil {
		return fmt.Errorf("encode request log: %w", err)
	}
	return s.logFile.Sync()
}

func decodeSingleJSON(reader io.Reader, target any) error {
	decoder := json.NewDecoder(io.LimitReader(reader, maxRequestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request body must contain exactly one JSON value")
	}
	return nil
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	if err := json.NewEncoder(response).Encode(body); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
