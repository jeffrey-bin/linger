package native

import (
	"bufio"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	codexRolloutProbeLines = 16
	codexRolloutProbeLine  = 1 << 20
	codexRolloutLimit      = 256 << 20
	codexRolloutDepth      = 3
)

// codexUsage is one raw usage value as Codex reports it: input includes
// cached and cache-write tokens; reasoning is part of output.
type codexUsage struct {
	Input        int64
	Cached       int64
	CacheRead    int64
	CacheWrite   int64
	HasWrite     bool
	Output       int64
	Reasoning    int64
	HasReasoning bool
}

func (u codexUsage) zero() bool {
	return u.Input == 0 && u.Cached == 0 && u.CacheRead == 0 && u.CacheWrite == 0 && u.Output == 0 && u.Reasoning == 0
}

func (u codexUsage) cached() int64 {
	if u.Cached == 0 {
		return u.CacheRead
	}
	return u.Cached
}

// receipt converts to the Daemon's token count.
func (u codexUsage) receipt() TokenCount {
	cached := u.cached()
	write := int64(0)
	if u.HasWrite {
		write = max(u.CacheWrite, 0)
	}
	return TokenCount{
		Input:      max(u.Input-cached-write, 0),
		CacheRead:  max(cached, 0),
		CacheWrite: write,
		Output:     max(u.Output, 0),
		Reasoning:  max(u.Reasoning, 0),
	}
}

func (u codexUsage) minus(previous codexUsage) codexUsage {
	out := u
	out.Input -= previous.Input
	out.Cached -= previous.Cached
	out.CacheRead -= previous.CacheRead
	out.CacheWrite -= previous.CacheWrite
	out.Output -= previous.Output
	out.Reasoning -= previous.Reasoning
	return out
}

func (u codexUsage) plus(other codexUsage) codexUsage {
	out := u
	out.Input += other.Input
	out.Cached += other.Cached
	out.CacheRead += other.CacheRead
	out.CacheWrite += other.CacheWrite
	out.HasWrite = out.HasWrite || other.HasWrite
	out.Output += other.Output
	out.Reasoning += other.Reasoning
	out.HasReasoning = out.HasReasoning || other.HasReasoning
	return out
}

func (u codexUsage) decreasedFrom(previous codexUsage) bool {
	return u.Input < previous.Input || u.cached() < previous.cached() || u.CacheWrite < previous.CacheWrite ||
		u.Output < previous.Output || u.Reasoning < previous.Reasoning
}

// codexUsageFields reads a usage object, trying each alias in order.
func codexUsageFields(raw json.RawMessage, input, cached, cacheRead, write, output, reasoning []string) (codexUsage, bool) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return codexUsage{}, false
	}
	read := func(keys []string) (int64, bool) {
		for _, key := range keys {
			if value, ok := object[key]; ok {
				var number float64
				if json.Unmarshal(value, &number) == nil {
					return int64(number), true
				}
			}
		}
		return 0, false
	}
	var u codexUsage
	u.Input, _ = read(input)
	u.Cached, _ = read(cached)
	u.CacheRead, _ = read(cacheRead)
	u.CacheWrite, u.HasWrite = read(write)
	u.Output, _ = read(output)
	u.Reasoning, u.HasReasoning = read(reasoning)
	return u, true
}

func codexLiveUsage(raw json.RawMessage) (codexUsage, bool) {
	return codexUsageFields(raw, []string{"input_tokens", "input"}, []string{"cached_input_tokens", "cache_read_tokens"}, nil,
		[]string{"cache_write_tokens"}, []string{"output_tokens", "output"}, []string{"reasoning_output_tokens", "reasoning_tokens"})
}

func codexCamelUsage(raw json.RawMessage) (codexUsage, bool) {
	return codexUsageFields(raw, []string{"inputTokens"}, []string{"cachedInputTokens"}, nil,
		[]string{"cacheWriteInputTokens"}, []string{"outputTokens"}, []string{"reasoningOutputTokens"})
}

func codexRolloutUsage(raw json.RawMessage) (codexUsage, bool) {
	return codexUsageFields(raw, []string{"input_tokens"}, []string{"cached_input_tokens"}, []string{"cache_read_input_tokens"},
		[]string{"cache_write_input_tokens"}, []string{"output_tokens"}, []string{"reasoning_output_tokens"})
}

// codexRollout is what a rollout scan contributes to one Operation.
type codexRollout struct {
	usage       codexUsage
	hasUsage    bool
	last        *codexUsage
	model       string
	compactions int64
}

// codexFindRollout returns the newest rollout whose session_meta names
// threadID. File names grant nothing; symlinks are ignored.
func codexFindRollout(home, threadID string) string {
	if home == "" || threadID == "" {
		return ""
	}
	type candidate struct {
		path string
		mod  time.Time
	}
	var found []candidate
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, entry := range entries {
			path := filepath.Join(dir, entry.Name())
			switch {
			case entry.Type()&fs.ModeSymlink != 0:
			case entry.IsDir():
				if depth < codexRolloutDepth {
					walk(path, depth+1)
				}
			case entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".jsonl"):
				info, err := entry.Info()
				if err == nil && codexRolloutOwner(path) == threadID {
					found = append(found, candidate{path, info.ModTime()})
				}
			}
		}
	}
	walk(filepath.Join(home, "sessions"), 0)
	if len(found) == 0 {
		return ""
	}
	sort.Slice(found, func(i, j int) bool {
		if !found[i].mod.Equal(found[j].mod) {
			return found[i].mod.After(found[j].mod)
		}
		return found[i].path > found[j].path
	})
	return found[0].path
}

// codexRolloutOwner reads the first session_meta within the first lines.
func codexRolloutOwner(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64<<10), codexRolloutProbeLine)
	for line := 0; line < codexRolloutProbeLines && scanner.Scan(); line++ {
		var record struct {
			Type    string `json:"type"`
			Payload struct {
				ID string `json:"id"`
			} `json:"payload"`
		}
		if json.Unmarshal(scanner.Bytes(), &record) == nil && record.Type == "session_meta" {
			return record.Payload.ID
		}
	}
	return ""
}

// codexScanRollout reads the usage that belongs to an Operation started at
// start. Before the boundary, totals only seed the previous value.
func codexScanRollout(home, threadID string, start time.Time, resumed bool) (codexRollout, bool) {
	path := codexFindRollout(home, threadID)
	if path == "" {
		return codexRollout{}, false
	}
	file, err := os.Open(path)
	if err != nil {
		return codexRollout{}, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > codexRolloutLimit {
		return codexRollout{}, false
	}
	var out codexRollout
	var previous *codexUsage
	belongingSeen := false
	scanner := newFrameScanner(file)
	for scanner.Scan() {
		var record struct {
			Timestamp string          `json:"timestamp"`
			Type      string          `json:"type"`
			Payload   json.RawMessage `json:"payload"`
		}
		if json.Unmarshal(scanner.Bytes(), &record) != nil {
			continue
		}
		var payload struct {
			Type  string `json:"type"`
			Model string `json:"model"`
			Info  *struct {
				Total json.RawMessage `json:"total_token_usage"`
				Last  json.RawMessage `json:"last_token_usage"`
				Model string          `json:"model"`
			} `json:"info"`
		}
		_ = json.Unmarshal(record.Payload, &payload)
		at, err := time.Parse(time.RFC3339Nano, record.Timestamp)
		hasTime := err == nil && record.Timestamp != ""
		belongs := true
		switch {
		case start.IsZero():
		case hasTime:
			belongs = !at.Before(start)
		case resumed:
			belongs = belongingSeen
		}
		if hasTime && belongs {
			belongingSeen = true
		}
		switch {
		case record.Type == "turn_context":
			if payload.Model != "" {
				out.model = payload.Model
			}
		case record.Type == "compacted" || payload.Type == "context_compacted":
			if belongs {
				out.compactions++
			}
		case record.Type == "event_msg" && payload.Type == "token_count" && payload.Info != nil:
			if payload.Info.Model != "" {
				out.model = payload.Info.Model
			}
			total, hasTotal := codexRolloutUsage(payload.Info.Total)
			last, hasLast := codexRolloutUsage(payload.Info.Last)
			if !belongs {
				if hasTotal {
					previous = &total
				}
				continue
			}
			switch {
			case hasTotal:
				delta := total
				if previous != nil && !total.decreasedFrom(*previous) {
					delta = total.minus(*previous)
				}
				out.usage = out.usage.plus(delta)
				out.hasUsage = true
				previous = &total
			case hasLast:
				out.usage, out.hasUsage = last, true
			}
			if hasLast {
				lastCopy := last
				out.last = &lastCopy
			}
		}
	}
	if scanner.Err() != nil || (!out.hasUsage && out.last == nil) {
		return codexRollout{}, false
	}
	return out, true
}

// codexUsageTotal is a usage report's running total: input (which includes
// cached input) plus output (which includes reasoning).
func codexUsageTotal(raw json.RawMessage) (int64, bool) {
	var usage struct {
		Total json.RawMessage `json:"total"`
	}
	if json.Unmarshal(raw, &usage) != nil {
		return 0, false
	}
	total, ok := codexCamelUsage(usage.Total)
	return total.Input + total.Output, ok
}

// advanceTotal records a thread's reported total and reports whether it
// grew. Totals live with the process, which keeps a thread across turns.
func (p *codexProcess) advanceTotal(thread string, sum int64) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.responseTotals == nil {
		p.responseTotals = map[string]int64{}
	}
	if sum <= p.responseTotals[thread] {
		return false
	}
	p.responseTotals[thread] = sum
	return true
}

// observeTokenUsage turns a usage report into a model response. Codex
// repeats a report without a new request, so only a larger total counts.
func (op *codexOperation) observeTokenUsage(thread string, child codexChild, raw json.RawMessage) {
	now := time.Now()
	var usage struct {
		Total json.RawMessage `json:"total"`
		Last  json.RawMessage `json:"last"`
	}
	if json.Unmarshal(raw, &usage) != nil {
		return
	}
	last, ok := codexCamelUsage(usage.Last)
	sum, hasTotal := codexUsageTotal(raw)
	if !ok || !hasTotal || !op.proc.advanceTotal(thread, sum) {
		return
	}
	response := ModelResponse{Model: child.model, Usage: last.receipt()}
	if child.parentCallID != "" {
		response.Agent, response.ParentCallID = thread, child.parentCallID
	} else {
		response.Model = op.spec.Model
		if response.Model == "" {
			op.proc.mu.Lock()
			response.Model = op.proc.threadModel
			op.proc.mu.Unlock()
		}
	}
	response = op.requests.respond(response, now)
	op.emit(Event{Kind: EventModelResponse, ObservedAt: now, Response: &response})
}

// collectUsage fills the Outcome's usage from live data, else the rollout.
func (op *codexOperation) collectUsage(out *Outcome) {
	op.mu.Lock()
	live, last, compactions := op.liveUsage, op.lastUsage, op.compactions
	op.mu.Unlock()
	thread := op.proc.boundThread()
	model := op.spec.Model
	var usage *codexUsage
	if live != nil && !live.zero() {
		usage = live
	}
	if rollout, ok := codexScanRollout(op.proc.home, thread, op.startedAt, op.resumed); ok {
		if usage == nil && rollout.hasUsage && !rollout.usage.zero() {
			usage, last, compactions = &rollout.usage, rollout.last, rollout.compactions
			if model == "" {
				model = rollout.model
			}
		}
	}
	if model == "" {
		model = "unknown"
	}
	out.Usage, out.LastUsage = nil, nil
	if usage != nil && usage.receipt() != (TokenCount{}) {
		out.Usage = map[string]TokenCount{model: usage.receipt()}
	}
	if last != nil {
		out.LastUsage = map[string]TokenCount{model: last.receipt()}
	}
	count := compactions
	out.CompactionCount = &count
}
