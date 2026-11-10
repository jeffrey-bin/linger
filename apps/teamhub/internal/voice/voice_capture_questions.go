package voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicecaptureqa"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const (
	// VoiceCaptureQuestionMaxRunes bounds a recording question.
	VoiceCaptureQuestionMaxRunes = 1000
	// VoiceCaptureQuestionTimeout bounds an answer. It runs on the recorder's
	// Agent Runtime, which takes ten to fifteen seconds; the Web shows a
	// thinking state meanwhile.
	VoiceCaptureQuestionTimeout = 45 * time.Second
)

// VoiceCaptureQuestionModel presents a recording question.
func VoiceCaptureQuestionModel(row store.VoiceCaptureQuestion) (httpapi.VoiceCaptureQuestion, error) {
	item := httpapi.VoiceCaptureQuestion{
		Id: row.ID, Kind: httpapi.VoiceCaptureQuestionKind(row.Kind), Question: row.Question, Answer: row.Answer, Answered: row.Answered,
		CutoffOffsetMs: row.CutoffOffsetMs, CreatedAt: row.CreatedAt.Time, Sources: []httpapi.VoiceCaptureQuestionSource{},
	}
	if row.Kind == voicecaptureqa.KindTask {
		item.TaskTitle = &row.TaskTitle
	}
	if row.SentMessageID.Valid {
		item.SentMessageId = &row.SentMessageID.String
	}
	return item, json.Unmarshal(row.Sources, &item.Sources)
}

// ErrCaptureQuestionUnanswered reports that the recording's Agent could not
// answer now; the caller may retry.
var ErrCaptureQuestionUnanswered = errors.New("the recording question could not be answered right now")

// ErrNotTaskRequest reports a question that is not a task request.
var ErrNotTaskRequest = errors.New("only a task request can be handed to Another Me")

// OwnedCapture reads a LiveKit Capture the Account recorded. Questions and
// task requests are private to the recorder.
func (s *Service) OwnedCapture(ctx context.Context, accountID, captureID string) (store.GetOwnedLiveKitCaptureForAccountRow, error) {
	return s.queries.GetOwnedLiveKitCaptureForAccount(ctx, store.GetOwnedLiveKitCaptureForAccountParams{
		AccountID: accountID, CaptureID: captureID,
	})
}

// ListCaptureQuestions lists the recorder's questions about a Capture.
func (s *Service) ListCaptureQuestions(ctx context.Context, accountID, captureID string) ([]httpapi.VoiceCaptureQuestion, error) {
	if _, err := s.OwnedCapture(ctx, accountID, captureID); err != nil {
		return nil, err
	}
	rows, err := s.queries.ListVoiceCaptureQuestions(ctx, captureID)
	if err != nil {
		return nil, internal("list Voice Capture questions", err)
	}
	items := make([]httpapi.VoiceCaptureQuestion, 0, len(rows))
	for _, row := range rows {
		item, err := VoiceCaptureQuestionModel(row)
		if err != nil {
			return nil, internal("read Voice Capture question", err)
		}
		items = append(items, item)
	}
	return items, nil
}

// AskCaptureQuestion hands what the recorder typed to the recording's Agent,
// which answers a question from the live speech confirmed so far or
// recognizes a request for Another Me. Either is kept with the cutoff it
// could read; a task request becomes a Task when the recorder sends it
// (SendCaptureQuestionTask), so the window can show it being created. The
// caller checks that an answerer is configured.
func (s *Service) AskCaptureQuestion(ctx context.Context, accountID, captureID, question string) (httpapi.VoiceCaptureQuestion, error) {
	capture, err := s.OwnedCapture(ctx, accountID, captureID)
	if err != nil {
		return httpapi.VoiceCaptureQuestion{}, err
	}
	rows, err := s.queries.ListConfirmedVoiceCaptureSpeech(ctx, captureID)
	if err != nil {
		return httpapi.VoiceCaptureQuestion{}, internal("read Voice Capture transcript", err)
	}
	segments := make([]voicecaptureqa.Segment, len(rows))
	for index, row := range rows {
		segments[index] = voicecaptureqa.Segment{StartOffsetMS: row.StartOffsetMs, EndOffsetMS: row.EndOffsetMs, Text: row.Text, Speaker: row.SpeakerID.String}
	}
	answerCtx, cancel := context.WithTimeout(ctx, VoiceCaptureQuestionTimeout)
	defer cancel()
	// The recorder's Agent Runtime answers.
	owner := roomagent.ModelCallOwner{TenantID: capture.TenantID, OwnerActorID: capture.CreatedByActorID}
	answer, err := s.answerer.Answer(answerCtx, owner, question, segments)
	if ctx.Err() != nil {
		return httpapi.VoiceCaptureQuestion{}, ctx.Err()
	}
	if err != nil {
		s.logger.Warn("answer Voice Capture question", "error", err)
		return httpapi.VoiceCaptureQuestion{}, ErrCaptureQuestionUnanswered
	}
	sources := make([]httpapi.VoiceCaptureQuestionSource, len(answer.Sources))
	for index, source := range answer.Sources {
		sources[index] = httpapi.VoiceCaptureQuestionSource{StartOffsetMs: source.StartOffsetMS, EndOffsetMs: source.EndOffsetMS, Text: source.Text}
	}
	encodedSources, err := json.Marshal(sources)
	if err != nil {
		return httpapi.VoiceCaptureQuestion{}, internal("encode Voice Capture question sources", err)
	}
	row, err := s.queries.CreateVoiceCaptureQuestion(ctx, store.CreateVoiceCaptureQuestionParams{
		ID: idgen.New("voice_question"), CaptureSessionID: captureID, Kind: answer.Kind, Question: question,
		Answer: answer.Text, Answered: answer.Answered, CutoffOffsetMs: voicecaptureqa.Cutoff(segments), Sources: encodedSources,
		TaskTitle: answer.TaskTitle,
	})
	if err != nil {
		return httpapi.VoiceCaptureQuestion{}, internal("save Voice Capture question", err)
	}
	item, err := VoiceCaptureQuestionModel(row)
	if err != nil {
		return httpapi.VoiceCaptureQuestion{}, internal("read Voice Capture question", err)
	}
	return item, nil
}

// CaptureQuestionTask is a sent task request: Sent is the question when it
// had already been sent, otherwise Result is the send's response.
type CaptureQuestionTask struct {
	Sent   *httpapi.VoiceCaptureQuestion
	Result idempotency.Result
}

// SendCaptureQuestionTask hands a task request the recording's Agent
// recognized in Ask to the recorder's Another Me as a hidden Message: Another
// Me's Meta wakes and creates the background Task itself, while the recorder
// sees the request only in Ask. Its recording-context.md also carries the
// earlier Ask exchanges the request may refer to. Each request is sent at
// most once; sending it again returns it unchanged.
func (s *Service) SendCaptureQuestionTask(ctx context.Context, accountID, captureID, questionID string) (CaptureQuestionTask, error) {
	if _, err := s.OwnedCapture(ctx, accountID, captureID); err != nil {
		return CaptureQuestionTask{}, err
	}
	question, err := s.queries.GetVoiceCaptureQuestion(ctx, store.GetVoiceCaptureQuestionParams{CaptureSessionID: captureID, ID: questionID})
	if err != nil {
		return CaptureQuestionTask{}, fmt.Errorf("read recording task request: %w", err)
	}
	if question.Kind != voicecaptureqa.KindTask {
		return CaptureQuestionTask{}, ErrNotTaskRequest
	}
	if question.SentMessageID.Valid {
		item, err := VoiceCaptureQuestionModel(question)
		if err != nil {
			return CaptureQuestionTask{}, internal("read Voice Capture question", err)
		}
		return CaptureQuestionTask{Sent: &item}, nil
	}
	capture, err := s.queries.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: captureID, AccountID: textValue(accountID)})
	if err != nil {
		return CaptureQuestionTask{}, fmt.Errorf("read Voice Capture: %w", err)
	}
	questions, err := s.queries.ListVoiceCaptureQuestions(ctx, captureID)
	if err != nil {
		return CaptureQuestionTask{}, fmt.Errorf("read recording Ask: %w", err)
	}
	asks := []voicecaptureqa.ContextAsk{}
	for _, earlier := range questions {
		if earlier.ID == question.ID {
			break
		}
		asks = append(asks, voicecaptureqa.ContextAsk{Question: earlier.Question, Answer: earlier.Answer})
	}
	result, err := s.sendRecordingTask(ctx, accountID, capture, recordingTask{
		operation: "sendVoiceCaptureQuestionTask:" + question.ID, idempotencyKey: question.ID,
		hash:      idempotency.HashRequest(map[string]string{"capture": captureID, "question": question.ID}),
		text:      question.Question,
		atMS:      max(question.CutoffOffsetMs-capture.TranscriptStartOffsetMs.Int64, 0),
		throughMS: question.CutoffOffsetMs, commandID: "voice-ask:" + question.ID,
		asks: asks,
		respond: func(ctx context.Context, queries *store.Queries, messageID, _ string) (any, error) {
			sent, err := queries.RecordVoiceCaptureQuestionSent(ctx, store.RecordVoiceCaptureQuestionSentParams{
				ID: question.ID, SentMessageID: messageID,
			})
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrVoiceCaptureQuestionSent
			}
			if err != nil {
				return nil, err
			}
			return VoiceCaptureQuestionModel(store.VoiceCaptureQuestion(sent))
		},
	})
	return CaptureQuestionTask{Result: result}, err
}
