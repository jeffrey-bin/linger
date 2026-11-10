package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

type asyncHTTPResult struct {
	name   string
	status int
	body   []byte
	err    error
}

func waitForBlockedQuery(t *testing.T, env *testEnv, queryFragment string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var blocked bool
		err := env.pool.QueryRow(context.Background(), `
			select exists (
				select 1
				from pg_stat_activity
				where datname=current_database()
				  and pid<>pg_backend_pid()
				  and wait_event_type='Lock'
				  and position($1 in query)>0
			)`, queryFragment).Scan(&blocked)
		if err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for blocked query containing %q", queryFragment)
}

func startAsyncJSONRequest(results chan<- asyncHTTPResult, name string, client *http.Client, method, url, key string, payload any) error {
	return startAsyncJSONRequestWithHeaders(results, name, client, method, url, key, payload, nil)
}

func startAsyncJSONRequestWithHeaders(results chan<- asyncHTTPResult, name string, client *http.Client, method, url, key string, payload any, headers http.Header) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, url, body)
	if err != nil {
		return err
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	for name, values := range headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	go func() {
		response, err := client.Do(request)
		if err != nil {
			results <- asyncHTTPResult{name: name, err: err}
			return
		}
		defer response.Body.Close()
		responseBody, readErr := io.ReadAll(response.Body)
		results <- asyncHTTPResult{name: name, status: response.StatusCode, body: responseBody, err: readErr}
	}()
	return nil
}

// receiveWithin returns the next value from ch. It fails the test if none arrives within
// d, so a goroutine released only on the success path cannot hang the whole package.
func receiveWithin[T any](t *testing.T, ch <-chan T, d time.Duration) T {
	t.Helper()
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case value := <-ch:
		return value
	case <-timer.C:
		t.Fatalf("no value received within %s", d)
	}
	var zero T
	return zero
}

// waitWithin waits for wg, failing the test if the group is not done within d.
func waitWithin(t *testing.T, wg *sync.WaitGroup, d time.Duration) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		t.Fatalf("goroutines did not finish within %s", d)
	}
}
