package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

const (
	catalogExchangeBudget     = 30 * time.Second
	catalogExchangePipeBudget = time.Second
	catalogBootstrapLimit     = 4096
	catalogResponseLimit      = 32 << 20
)

// catalogReceiver handles one stdout frame of a catalog exchange. send
// writes more JSON lines to the child's stdin. Returning done ends the
// exchange successfully; an error cancels it. Unexpected frames should be
// ignored by returning (false, nil).
type catalogReceiver func(frame []byte, send func(requests ...any) error) (done bool, err error)

// exchangeCatalog talks to a short-lived CLI process without ever submitting
// a user turn. The initial requests are written to stdin before launch, so
// together they must fit the bootstrap limit (the smallest OS pipe buffer).
func exchangeCatalog(ctx context.Context, inv Invocation, args []string, requests []any, receive catalogReceiver) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("catalog process failed: %w", err)
	}
	bootstrap, err := encodeJSONLines(requests...)
	if err != nil {
		return err
	}
	if len(bootstrap) > catalogBootstrapLimit {
		return errors.New("catalog request exceeds bootstrap limit")
	}
	exchangeCtx, cancel := context.WithTimeout(ctx, catalogExchangeBudget)
	defer cancel()
	cmd := ownedCommand(exchangeCtx, inv, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if _, err := stdin.Write(bootstrap); err != nil {
		_ = stdin.Close()
		return err
	}
	session := &catalogSession{stdin: stdin, receive: receive, cancel: cancel}
	cmd.Stdout = session
	runErr := process.Run(exchangeCtx, cmd, catalogExchangePipeBudget)
	session.mu.Lock()
	defer session.mu.Unlock()
	switch {
	case session.err != nil:
		return session.err
	case runErr != nil:
		return fmt.Errorf("catalog process failed: %w", ExplainExecError(runErr))
	case !session.done:
		return errors.New("catalog process closed before the expected response")
	}
	return nil
}

// catalogSession frames the child's stdout and drives the receiver.
type catalogSession struct {
	mu      sync.Mutex
	stdin   io.WriteCloser
	receive catalogReceiver
	cancel  context.CancelFunc
	pending []byte
	total   int
	done    bool
	err     error
}

func (s *catalogSession) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done || s.err != nil {
		return len(p), nil
	}
	s.total += len(p)
	if s.total > catalogResponseLimit {
		s.stop(errors.New("catalog response exceeds 32 MiB"))
		return len(p), nil
	}
	s.pending = append(s.pending, p...)
	for !s.done && s.err == nil {
		newline := bytes.IndexByte(s.pending, '\n')
		if newline < 0 {
			break
		}
		frame := trimFrame(s.pending[:newline])
		done, err := s.receive(frame, s.send)
		s.pending = s.pending[newline+1:]
		switch {
		case err != nil:
			s.stop(err)
		case done:
			s.done = true
			s.pending = nil
			_ = s.stdin.Close()
		}
	}
	return len(p), nil
}

func (s *catalogSession) send(requests ...any) error {
	encoded, err := encodeJSONLines(requests...)
	if err != nil {
		return err
	}
	_, err = s.stdin.Write(encoded)
	return err
}

func (s *catalogSession) stop(err error) {
	s.err, s.pending = err, nil
	s.cancel()
}

func encodeJSONLines(values ...any) ([]byte, error) {
	var out bytes.Buffer
	for _, value := range values {
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		out.Write(encoded)
		out.WriteByte('\n')
	}
	return out.Bytes(), nil
}
