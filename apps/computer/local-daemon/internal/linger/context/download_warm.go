package lingercontext

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// A new TLS connection to a remote Agent costs several round trips, so the
// first Context download after a long pause is slow. The store keeps one
// pooled connection to the last content origin warm while Views are recent.
// Warm-up requests carry no capability.
type downloadWarmSettings struct {
	interval time.Duration
	window   time.Duration
}

// The interval stays below the transport's 90 second idle timeout.
var defaultDownloadWarm = downloadWarmSettings{interval: 45 * time.Second, window: 15 * time.Minute}

type downloadWarmer struct {
	mu       sync.Mutex
	target   string
	activeAt time.Time
	stop     context.CancelFunc
	done     chan struct{}
}

func (s *ViewStore) startDownloadWarmer(settings downloadWarmSettings) {
	s.warm.activeAt = time.Now()
	ctx, cancel := context.WithCancel(context.Background())
	s.warm.stop = cancel
	s.warm.done = make(chan struct{})
	go func() {
		defer close(s.warm.done)
		ticker := time.NewTicker(settings.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			s.warm.mu.Lock()
			target, active := s.warm.target, time.Since(s.warm.activeAt) < settings.window
			s.warm.mu.Unlock()
			if target != "" && active {
				s.warmDownload(ctx, target)
			}
		}
	}()
}

func (s *ViewStore) stopDownloadWarmer() {
	if s.warm.stop == nil {
		return
	}
	s.warm.stop()
	<-s.warm.done
}

func (s *ViewStore) noteDownloadActivity(contentURL string) {
	target := downloadWarmTarget(contentURL)
	s.warm.mu.Lock()
	defer s.warm.mu.Unlock()
	if target != "" {
		s.warm.target = target
	}
	s.warm.activeAt = time.Now()
}

func (s *ViewStore) warmDownload(ctx context.Context, target string) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, target, nil)
	if err != nil {
		return
	}
	response, err := s.httpClient.Do(request)
	if err != nil {
		return
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
}

// downloadWarmTarget keeps only the origin of the content URL, whose path
// carries the connection's capability.
func downloadWarmTarget(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return ""
	}
	return (&url.URL{Scheme: parsed.Scheme, Host: parsed.Host, Path: "/"}).String()
}
