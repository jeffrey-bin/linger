package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

type shutdownApplication interface {
	Handler() http.Handler
	BeginDrain()
	StopStreams()
	CloseContext(context.Context) error
}

func shutdownSignals() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
}

// The watchdog covers startup and cleanup, including operations that ignore ctx.
func serve(signalContext context.Context, cfg config.Config, logger *slog.Logger, initialize func(context.Context) (shutdownApplication, error)) int {
	finished := make(chan struct{})
	defer close(finished)
	var phase atomic.Value
	phase.Store("startup")
	budget := make(chan context.Context, 1)
	var requestOnce sync.Once
	requestShutdown := func() {
		requestOnce.Do(func() {
			ctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
			budget <- ctx
			logger.Info("shutdown requested", "timeout", cfg.ShutdownTimeout)
			go func() {
				defer cancel()
				select {
				case <-ctx.Done():
					logger.Error("shutdown timeout", "phase", phase.Load())
					os.Exit(1)
				case <-finished:
				}
			}()
		})
	}
	go func() {
		select {
		case <-signalContext.Done():
			requestShutdown()
		case <-finished:
		}
	}()
	application, err := initialize(signalContext)
	if err != nil {
		if signalContext.Err() != nil && errors.Is(err, context.Canceled) {
			return 0
		}
		logger.Error("initialize application", "error", err)
		return 1
	}
	var server *http.Server
	code := 0
	if signalContext.Err() == nil {
		server = &http.Server{Addr: cfg.HTTPAddress, Handler: application.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
		serverErrors := make(chan error, 1)
		go func() {
			logger.Info("TeamHub listening", "address", cfg.HTTPAddress)
			serverErrors <- server.ListenAndServe()
		}()
		phase.Store("serving")
		select {
		case <-signalContext.Done():
		case err := <-serverErrors:
			if !errors.Is(err, http.ErrServerClosed) {
				logger.Error("HTTP server stopped", "error", err)
				code = 1
			}
		}
	}
	requestShutdown()
	cleanupContext := <-budget
	application.BeginDrain()
	phase.Store("http")
	application.StopStreams()
	if server != nil {
		httpContext, cancelHTTP := context.WithTimeout(cleanupContext, cfg.ShutdownHTTPTimeout)
		err := server.Shutdown(httpContext)
		cancelHTTP()
		if err != nil {
			logger.Error("HTTP drain failed", "error", err)
			code = 1
			_ = server.Close()
		}
	}
	phase.Store("resources")
	if err := application.CloseContext(cleanupContext); err != nil {
		logger.Error("application cleanup failed", "error", err)
		code = 1
	}
	logger.Info("shutdown complete", "exit_code", code)
	return code
}
