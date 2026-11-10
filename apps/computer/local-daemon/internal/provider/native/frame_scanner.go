package native

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
)

const (
	frameInitialBuffer = 64 << 10
	frameLimit         = 32 << 20
)

// frameScanner reads one JSONL frame per line from a protocol stream. Its
// buffer starts small and grows only for large frames. An oversized frame or
// a read error ends the scan for good without exposing partial bytes.
type frameScanner struct {
	reader  io.Reader
	limit   int
	buf     []byte
	start   int
	end     int
	frame   []byte
	err     error
	readErr error
	eof     bool
	done    bool
}

func newFrameScanner(reader io.Reader) *frameScanner {
	return &frameScanner{reader: reader, limit: frameLimit}
}

// Scan advances to the next frame. It returns false at the end of the stream
// or on failure; Err tells which.
func (s *frameScanner) Scan() bool {
	s.frame = nil
	if s.done {
		return false
	}
	for {
		if newline := bytes.IndexByte(s.buf[s.start:s.end], '\n'); newline >= 0 {
			if newline+1 > s.limit {
				return s.fail(fmt.Errorf("protocol frame exceeds %d bytes: %w", s.limit, bufio.ErrTooLong))
			}
			s.frame = trimFrame(s.buf[s.start : s.start+newline])
			s.start += newline + 1
			return true
		}
		if s.end-s.start >= s.limit {
			return s.fail(fmt.Errorf("protocol frame exceeds %d bytes: %w", s.limit, bufio.ErrTooLong))
		}
		if s.readErr != nil {
			return s.fail(s.readErr)
		}
		if s.eof {
			s.done = true
			if s.end == s.start {
				return false
			}
			s.frame = trimFrame(s.buf[s.start:s.end])
			s.start = s.end
			return true
		}
		s.fill()
	}
}

func (s *frameScanner) fill() {
	if s.start > 0 {
		s.end = copy(s.buf, s.buf[s.start:s.end])
		s.start = 0
	}
	if s.end == len(s.buf) {
		size := max(2*len(s.buf), frameInitialBuffer)
		size = min(size, s.limit+1)
		grown := make([]byte, size)
		copy(grown, s.buf[:s.end])
		s.buf = grown
	}
	n, err := s.reader.Read(s.buf[s.end:])
	if n > 0 {
		s.end += n
	}
	if errors.Is(err, io.EOF) {
		s.eof = true
	} else if err != nil {
		s.readErr = err
	}
}

func (s *frameScanner) fail(err error) bool {
	s.err, s.frame, s.done = err, nil, true
	s.buf, s.start, s.end = nil, 0, 0
	return false
}

// Bytes returns the current frame. It is valid until the next Scan.
func (s *frameScanner) Bytes() []byte { return s.frame }

// Err returns the failure that ended the scan, or nil after a clean EOF.
func (s *frameScanner) Err() error { return s.err }

func trimFrame(line []byte) []byte {
	if n := len(line); n > 0 && line[n-1] == '\r' {
		return line[:n-1]
	}
	return line
}
