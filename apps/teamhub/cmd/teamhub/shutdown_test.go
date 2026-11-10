package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

type shutdownFixture struct {
	fail, hang, httpHang bool
	address              string
}

func (f *shutdownFixture) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.httpHang && r.URL.Path != "/probe" {
			println("FIXTURE_READY")
			<-r.Context().Done()
			return
		}
		w.WriteHeader(http.StatusOK)
	})
}
func (f *shutdownFixture) BeginDrain() {
	println("DRAIN")
	if f.httpHang {
		r, err := http.Get("http://" + f.address + "/probe")
		if err == nil {
			_ = r.Body.Close()
			if r.StatusCode == http.StatusOK {
				println("DRAIN_HTTP_OK")
			}
		}
	}
}
func (f *shutdownFixture) StopStreams() { println("STREAMS") }
func (f *shutdownFixture) CloseContext(ctx context.Context) error {
	println("CLOSE")
	if f.hang {
		select {}
	}
	if f.fail {
		return errors.New("cleanup failure")
	}
	return nil
}

func TestShutdownProcess(t *testing.T) {
	for _, mode := range []string{"success", "failure", "hang", "startup", "http-timeout"} {
		t.Run(mode, func(t *testing.T) {
			command := exec.Command(os.Args[0], "-test.run=^TestShutdownProcessHelper$")
			command.Env = append(os.Environ(), "TEAMHUB_SHUTDOWN_FIXTURE="+mode)
			reader, writer := io.Pipe()
			command.Stdout = writer
			command.Stderr = writer
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			defer command.Process.Kill()
			var output strings.Builder
			ready := make(chan struct{})
			readDone := make(chan struct{})
			go func() {
				defer close(readDone)
				b := make([]byte, 1024)
				signaled := false
				for {
					n, e := reader.Read(b)
					output.Write(b[:n])
					if !signaled && strings.Contains(output.String(), "FIXTURE_READY") {
						close(ready)
						signaled = true
					}
					if e != nil {
						return
					}
				}
			}()
			select {
			case <-ready:
			case <-time.After(5 * time.Second):
				t.Fatal("startup timeout")
			}
			started := time.Now()
			if err := command.Process.Signal(syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- command.Wait() }()
			select {
			case err := <-done:
				_ = writer.Close()
				<-readDone
				want := 0
				if mode != "success" {
					want = 1
				}
				if command.ProcessState.ExitCode() != want {
					t.Fatalf("exit %v: %s", err, output.String())
				}
			case <-time.After(3 * time.Second):
				t.Fatal("unbounded shutdown")
			}
			if time.Since(started) > 2*time.Second {
				t.Fatal("deadline exceeded")
			}
			if mode == "hang" || mode == "startup" {
				if !strings.Contains(output.String(), "shutdown timeout") {
					t.Fatal(output.String())
				}
			}
			if mode == "http-timeout" {
				if !strings.Contains(output.String(), "DRAIN_HTTP_OK") {
					t.Fatal("listener stopped serving before HTTP drain", output.String())
				}
				if !strings.Contains(output.String(), "CLOSE") {
					t.Fatal("HTTP failure skipped cleanup:", output.String())
				}
			}
			if mode == "success" {
				s := output.String()
				if !(strings.Index(s, "DRAIN") < strings.Index(s, "STREAMS") && strings.Index(s, "STREAMS") < strings.Index(s, "CLOSE")) {
					t.Fatal(s)
				}
			}
		})
	}
}

func TestShutdownProcessHelper(t *testing.T) {
	mode := os.Getenv("TEAMHUB_SHUTDOWN_FIXTURE")
	if mode == "" {
		return
	}
	ctx, stop := shutdownSignals()
	defer stop()
	cfg := config.ForTest(func(c *config.Config) {
		c.HTTPAddress = "127.0.0.1:0"
		c.ShutdownTimeout = 250 * time.Millisecond
		c.ShutdownHTTPTimeout = 50 * time.Millisecond
	})
	var reserved net.Listener
	if mode == "http-timeout" {
		var err error
		reserved, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		cfg.HTTPAddress = reserved.Addr().String()
		_ = reserved.Close()
	}
	code := serve(ctx, cfg, slog.New(slog.NewTextHandler(os.Stdout, nil)), func(ctx context.Context) (shutdownApplication, error) {
		if mode == "startup" {
			println("FIXTURE_READY")
			select {}
		}
		if mode == "http-timeout" {
			go func() {
				for i := 0; i < 100; i++ {
					response, err := http.Get("http://" + cfg.HTTPAddress)
					if err == nil {
						_ = response.Body.Close()
						return
					}
					time.Sleep(10 * time.Millisecond)
				}
			}()
		} else {
			go func() { time.Sleep(30 * time.Millisecond); println("FIXTURE_READY") }()
		}
		return &shutdownFixture{fail: mode == "failure", hang: mode == "hang", httpHang: mode == "http-timeout", address: cfg.HTTPAddress}, nil
	})
	os.Exit(code)
}
