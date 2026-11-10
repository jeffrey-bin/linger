package voicetranscription

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Asynchronous transcription needs an async model; Voice Runtime streams with
// stt-rt-v5.
const (
	defaultSonioxBaseURL     = "https://api.soniox.com"
	sonioxTranscriptionModel = "stt-async-v5"
)

// SonioxLanguageHints bias short, ambiguous openings without excluding other
// languages. Voice Runtime's live transcription uses the same hints.
var SonioxLanguageHints = []string{"zh", "en"}

type SonioxConfig struct {
	APIKey        string
	BaseURL       string
	HTTPClient    *http.Client
	LanguageHints []string
}

type SonioxTranscriber struct {
	apiKey        string
	baseURL       string
	httpClient    *http.Client
	model         string
	languageHints []string
}

func NewSonioxTranscriber(cfg SonioxConfig) (*SonioxTranscriber, error) {
	baseURL := strings.TrimSpace(cfg.BaseURL)
	if baseURL == "" {
		baseURL = defaultSonioxBaseURL
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("voice transcription base URL must be an absolute HTTP URL without credentials, query, or fragment")
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		return nil, errors.New("voice transcription API key is required for Soniox")
	}
	client := cfg.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	languageHints := make([]string, 0, len(cfg.LanguageHints))
	for _, hint := range cfg.LanguageHints {
		hint = strings.TrimSpace(hint)
		if hint == "" {
			continue
		}
		languageHints = append(languageHints, hint)
	}
	return &SonioxTranscriber{
		apiKey: cfg.APIKey, baseURL: strings.TrimRight(baseURL, "/"), httpClient: client,
		model: sonioxTranscriptionModel, languageHints: languageHints,
	}, nil
}

type sonioxToken struct {
	Text    string `json:"text"`
	StartMS int64  `json:"start_ms"`
	EndMS   int64  `json:"end_ms"`
	Speaker any    `json:"speaker"`
}

type sonioxFileResponse struct {
	ID string `json:"id"`
}

type sonioxTranscriptionResponse struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type sonioxTranscriptResponse struct {
	Text   string        `json:"text"`
	Tokens []sonioxToken `json:"tokens"`
}

// TranscribeArchivePCM transcribes one bounded 16 kHz mono PCM block through
// Soniox async file transcription. The completed transcript is the provider's
// final acknowledgement, including when the whole block is silence.
func (t *SonioxTranscriber) TranscribeArchivePCM(ctx context.Context, pcm []byte) ([]StreamingResult, error) {
	if len(pcm) == 0 || len(pcm)%2 != 0 || len(pcm) > 60*16000*2 {
		return nil, ErrInvalidInput
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	transcript, err := t.recognize(ctx, wrapPCM16MonoWAV(pcm, 16000))
	if err != nil {
		return nil, err
	}
	totalMS := int64(len(pcm) / 32)
	return sonioxSegments(transcript, totalMS)
}

// recognize transcribes one recording block with speaker diarization.
func (t *SonioxTranscriber) recognize(ctx context.Context, payload []byte) (*sonioxTranscriptResponse, error) {
	fileID, err := t.upload(ctx, payload)
	if err != nil {
		return nil, err
	}
	id, err := t.submit(ctx, fileID)
	if err != nil {
		return nil, err
	}
	if err := t.poll(ctx, id); err != nil {
		return nil, err
	}
	return t.transcript(ctx, id)
}

func (t *SonioxTranscriber) upload(ctx context.Context, payload []byte) (string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "archive.wav")
	if err != nil {
		return "", ErrProviderFailure
	}
	if _, err := part.Write(payload); err != nil {
		return "", ErrProviderFailure
	}
	if err := writer.Close(); err != nil {
		return "", ErrProviderFailure
	}
	var parsed sonioxFileResponse
	if err := t.doJSON(ctx, http.MethodPost, t.baseURL+"/v1/files", writer.FormDataContentType(), body.Bytes(), &parsed); err != nil {
		return "", err
	}
	if strings.TrimSpace(parsed.ID) == "" {
		return "", ErrInvalidProviderResponse
	}
	return parsed.ID, nil
}

func (t *SonioxTranscriber) submit(ctx context.Context, fileID string) (string, error) {
	body := map[string]any{
		"file_id":                    fileID,
		"model":                      t.model,
		"enable_speaker_diarization": true,
	}
	if len(t.languageHints) > 0 {
		body["language_hints"] = t.languageHints
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return "", ErrProviderFailure
	}
	var parsed sonioxTranscriptionResponse
	if err := t.doJSON(ctx, http.MethodPost, t.baseURL+"/v1/transcriptions", "application/json", encoded, &parsed); err != nil {
		return "", err
	}
	if strings.TrimSpace(parsed.ID) == "" {
		return "", ErrInvalidProviderResponse
	}
	return parsed.ID, nil
}

func (t *SonioxTranscriber) poll(ctx context.Context, id string) error {
	for {
		var parsed sonioxTranscriptionResponse
		if err := t.doJSON(ctx, http.MethodGet, t.baseURL+"/v1/transcriptions/"+url.PathEscape(id), "", nil, &parsed); err != nil {
			return err
		}
		switch strings.ToLower(parsed.Status) {
		case "completed":
			return nil
		case "error":
			return ErrProviderFailure
		}
		if err := waitPoll(ctx, 200*time.Millisecond); err != nil {
			return err
		}
	}
}

func (t *SonioxTranscriber) transcript(ctx context.Context, id string) (*sonioxTranscriptResponse, error) {
	var parsed sonioxTranscriptResponse
	if err := t.doJSON(ctx, http.MethodGet, t.baseURL+"/v1/transcriptions/"+url.PathEscape(id)+"/transcript", "", nil, &parsed); err != nil {
		return nil, err
	}
	return &parsed, nil
}

func (t *SonioxTranscriber) doJSON(ctx context.Context, method, endpoint, contentType string, payload []byte, parsed any) error {
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return ErrProviderFailure
	}
	request.Header.Set("Authorization", "Bearer "+t.apiKey)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := t.httpClient.Do(request)
	if err != nil {
		return mapProviderTransportError(ctx, err)
	}
	defer response.Body.Close()
	if err := mapProviderHTTPStatus(response.StatusCode); err != nil {
		return err
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4<<20))
	if err := decoder.Decode(parsed); err != nil {
		return ErrInvalidProviderResponse
	}
	return nil
}

func sonioxSegments(transcript *sonioxTranscriptResponse, totalMS int64) ([]StreamingResult, error) {
	groups := groupSonioxTokens(transcript.Tokens)
	var segments []StreamingResult
	textBytes := 0
	wordCount := 0
	if len(groups) == 0 && strings.TrimSpace(transcript.Text) != "" {
		return []StreamingResult{{
			Text: strings.TrimSpace(transcript.Text), StartMS: 0, EndMS: totalMS,
			ProcessedMS: totalMS, Final: true,
		}}, nil
	}
	for _, group := range groups {
		text := strings.TrimSpace(sonioxTokenText(group))
		if text == "" {
			continue
		}
		startMS := group[0].StartMS
		endMS := group[len(group)-1].EndMS
		words, validWords := mapSonioxTimedWords(text, endMS, group)
		textBytes += len(text)
		wordCount += len(words)
		if startMS < 0 || endMS <= startMS || endMS > totalMS+250 || !validWords ||
			len(segments) >= 512 || textBytes > 64<<10 || wordCount > 16*1024 {
			return nil, ErrInvalidProviderResponse
		}
		segments = append(segments, StreamingResult{
			Text: text, StartMS: startMS, EndMS: endMS,
			ProcessedMS: totalMS, Final: true, Words: words,
			SpeakerID: sonioxGroupSpeakerID(group),
		})
	}
	sort.SliceStable(segments, func(i, j int) bool { return segments[i].StartMS < segments[j].StartMS })
	for i := 1; i < len(segments); i++ {
		if segments[i].StartMS < segments[i-1].EndMS {
			return nil, ErrInvalidProviderResponse
		}
	}
	return segments, nil
}

func groupSonioxTokens(input []sonioxToken) [][]sonioxToken {
	var groups [][]sonioxToken
	var current []sonioxToken
	var previousEnd int64
	var speaker int
	var hasSpeaker bool
	for _, token := range input {
		if token.Text == "<end>" {
			if len(current) > 0 {
				groups = append(groups, current)
				current = nil
			}
			continue
		}
		if strings.TrimSpace(token.Text) == "" {
			if len(current) > 0 {
				current = append(current, token)
			}
			continue
		}
		nextSpeaker, ok := sonioxSpeakerIndex(token.Speaker)
		speakerChanged := ok && hasSpeaker && nextSpeaker != speaker
		if len(current) > 0 && (token.StartMS-previousEnd > 500 || speakerChanged) {
			groups = append(groups, current)
			current = nil
		}
		current = append(current, token)
		previousEnd = token.EndMS
		if ok {
			speaker = nextSpeaker
			hasSpeaker = true
		}
	}
	if len(current) > 0 {
		groups = append(groups, current)
	}
	return groups
}

func sonioxGroupSpeakerID(group []sonioxToken) string {
	for _, token := range group {
		if index, ok := sonioxSpeakerIndex(token.Speaker); ok {
			return SpeakerIDFromOneBased(index)
		}
	}
	return ""
}

func sonioxSpeakerIndex(value any) (int, bool) {
	switch parsed := value.(type) {
	case int:
		return parsed, true
	case int32:
		return int(parsed), true
	case int64:
		return int(parsed), true
	case float64:
		index := int(parsed)
		if float64(index) != parsed {
			return 0, false
		}
		return index, true
	case json.Number:
		index, err := parsed.Int64()
		if err != nil {
			return 0, false
		}
		return int(index), true
	case string:
		index, err := strconv.Atoi(strings.TrimSpace(parsed))
		if err != nil {
			return 0, false
		}
		return index, true
	default:
		return 0, false
	}
}

func sonioxTokenText(tokens []sonioxToken) string {
	parts := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if token.Text == "<end>" {
			continue
		}
		parts = append(parts, token.Text)
	}
	return strings.Join(parts, "")
}

func mapSonioxTimedWords(text string, endMS int64, input []sonioxToken) ([]TimedWord, bool) {
	if len(input) == 0 || len(input) > 1024 || len(text) > 64*1024 {
		return nil, len(input) == 0
	}
	words := make([]TimedWord, 0, len(input))
	cursor := 0
	var previousMS int64
	for _, token := range input {
		piece := strings.TrimSpace(token.Text)
		if piece == "" || token.Text == "<end>" {
			continue
		}
		if token.EndMS < token.StartMS {
			return nil, false
		}
		from := token.StartMS
		through := min(token.EndMS, endMS)
		if from < previousMS || through < from {
			return nil, false
		}
		at := strings.Index(text[cursor:], piece)
		if at < 0 {
			return nil, false
		}
		at += cursor
		words = append(words, TimedWord{
			StartMS: from, EndMS: through,
			TextStart: at, TextEnd: at + len(piece),
		})
		cursor = at + len(piece)
		previousMS = from
	}
	return words, true
}

func mapProviderTransportError(ctx context.Context, err error) error {
	var networkError net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) || (errors.As(err, &networkError) && networkError.Timeout()) {
		return ErrProviderTimeout
	}
	if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		return ErrProviderTimeout
	}
	return ErrProviderFailure
}

func mapProviderHTTPStatus(status int) error {
	if status == http.StatusTooManyRequests {
		return ErrProviderRateLimited
	}
	if status >= 400 && status < 500 {
		return ErrProviderRejected
	}
	if status < 200 || status >= 300 {
		return ErrProviderFailure
	}
	return nil
}

func waitPoll(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return mapProviderTransportError(ctx, ctx.Err())
	case <-timer.C:
		return nil
	}
}

func wrapPCM16MonoWAV(pcm []byte, sampleRate int) []byte {
	header := make([]byte, 44)
	copy(header[0:], []byte("RIFF"))
	binary.LittleEndian.PutUint32(header[4:], uint32(36+len(pcm)))
	copy(header[8:], []byte("WAVE"))
	copy(header[12:], []byte("fmt "))
	binary.LittleEndian.PutUint32(header[16:], 16)
	binary.LittleEndian.PutUint16(header[20:], 1)
	binary.LittleEndian.PutUint16(header[22:], 1)
	binary.LittleEndian.PutUint32(header[24:], uint32(sampleRate))
	binary.LittleEndian.PutUint32(header[28:], uint32(sampleRate*2))
	binary.LittleEndian.PutUint16(header[32:], 2)
	binary.LittleEndian.PutUint16(header[34:], 16)
	copy(header[36:], []byte("data"))
	binary.LittleEndian.PutUint32(header[40:], uint32(len(pcm)))
	return append(header, pcm...)
}
