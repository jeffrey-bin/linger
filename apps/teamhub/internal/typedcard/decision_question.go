package typedcard

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// DecisionQuestion is one question a question card asks.
type DecisionQuestion struct {
	ID      string                   `json:"id"`
	Prompt  string                   `json:"prompt"`
	Input   string                   `json:"input"`
	Options []DecisionQuestionOption `json:"options"`
}

// DecisionQuestionOption is one choice of a radio or checkbox question.
type DecisionQuestionOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// QuestionDecision asks a Human the card's questions. Runtime is set for a
// Runtime's native question: the binding to the Run that waits for the answer.
type QuestionDecision struct {
	Prompt    string
	Questions []DecisionQuestion
	Runtime   json.RawMessage
}

// questionView is what a question card stores and shows.
type questionView struct {
	Prompt    string             `json:"prompt"`
	Questions []DecisionQuestion `json:"questions"`
}

// decisionRuntimeRequest is the request of a card a Runtime asked for.
type decisionRuntimeRequest struct {
	Runtime json.RawMessage `json:"runtime,omitempty"`
}

func normalizePrompt(prompt string) (string, error) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" || utf8.RuneCountInString(prompt) > 2000 {
		return "", ErrInvalid
	}
	return prompt, nil
}

func normalizeQuestions(questions []DecisionQuestion) ([]DecisionQuestion, error) {
	if len(questions) == 0 || len(questions) > 20 {
		return nil, ErrInvalid
	}
	normalized := make([]DecisionQuestion, 0, len(questions))
	seen := map[string]struct{}{}
	for _, question := range questions {
		question, err := normalizeQuestion(question)
		if err != nil {
			return nil, err
		}
		if _, duplicate := seen[question.ID]; duplicate {
			return nil, ErrInvalid
		}
		seen[question.ID] = struct{}{}
		normalized = append(normalized, question)
	}
	return normalized, nil
}

func normalizeQuestion(question DecisionQuestion) (DecisionQuestion, error) {
	question.ID = strings.TrimSpace(question.ID)
	question.Prompt = strings.TrimSpace(question.Prompt)
	question.Input = strings.TrimSpace(question.Input)
	if question.ID == "" || utf8.RuneCountInString(question.ID) > 64 ||
		question.Prompt == "" || utf8.RuneCountInString(question.Prompt) > 2000 {
		return DecisionQuestion{}, ErrInvalid
	}
	switch question.Input {
	case "radio", "checkbox":
		if len(question.Options) == 0 || len(question.Options) > 20 {
			return DecisionQuestion{}, ErrInvalid
		}
		options := make([]DecisionQuestionOption, 0, len(question.Options))
		seen := map[string]struct{}{}
		for _, option := range question.Options {
			option.ID = strings.TrimSpace(option.ID)
			option.Label = strings.TrimSpace(option.Label)
			if option.ID == "" || utf8.RuneCountInString(option.ID) > 64 ||
				option.Label == "" || utf8.RuneCountInString(option.Label) > 200 {
				return DecisionQuestion{}, ErrInvalid
			}
			if _, duplicate := seen[option.ID]; duplicate {
				return DecisionQuestion{}, ErrInvalid
			}
			seen[option.ID] = struct{}{}
			options = append(options, DecisionQuestionOption{ID: option.ID, Label: option.Label})
		}
		return DecisionQuestion{ID: question.ID, Prompt: question.Prompt, Input: question.Input, Options: options}, nil
	default:
		return DecisionQuestion{}, ErrInvalid
	}
}

func normalizeQuestionAnswers(questions []DecisionQuestion, raw map[string]any) (map[string]any, error) {
	if len(raw) != len(questions) {
		return nil, ErrInvalid
	}
	answers := make(map[string]any, len(questions))
	for _, question := range questions {
		value, found := raw[question.ID]
		if !found {
			return nil, ErrInvalid
		}
		normalized, err := normalizeQuestionAnswer(question, value)
		if err != nil {
			return nil, err
		}
		answers[question.ID] = normalized
	}
	return answers, nil
}

// normalizeQuestionAnswer accepts option ids for radio and checkbox questions.
// Any other value is the Human's own written answer ("Other…"), which every
// option question takes; readers show it as written.
func normalizeQuestionAnswer(question DecisionQuestion, value any) (any, error) {
	switch question.Input {
	case "radio":
		text, ok := value.(string)
		text = strings.TrimSpace(text)
		if !ok || text == "" || utf8.RuneCountInString(text) > 10000 {
			return nil, ErrInvalid
		}
		return text, nil
	case "checkbox":
		values, ok := stringSlice(value)
		if !ok || len(values) == 0 {
			return nil, ErrInvalid
		}
		seen := map[string]struct{}{}
		normalized := make([]string, 0, len(values))
		for _, item := range values {
			item = strings.TrimSpace(item)
			if item == "" || utf8.RuneCountInString(item) > 200 {
				return nil, ErrInvalid
			}
			if _, duplicate := seen[item]; duplicate {
				return nil, ErrInvalid
			}
			seen[item] = struct{}{}
			normalized = append(normalized, item)
		}
		return normalized, nil
	default:
		return nil, ErrInvalid
	}
}

func stringSlice(value any) ([]string, bool) {
	switch typed := value.(type) {
	case []string:
		return typed, true
	case []any:
		values := make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				return nil, false
			}
			values = append(values, text)
		}
		return values, true
	default:
		return nil, false
	}
}

// questionNoticeText writes an answered question card for its Agent: each
// question with the chosen option labels or the written answer.
func questionNoticeText(decisionID string, view questionView, answer decisionAnswer) string {
	var text strings.Builder
	text.WriteString("Human interaction " + decisionID + " answered:")
	for _, question := range view.Questions {
		var answers []string
		switch value := answer.Answers[question.ID].(type) {
		case string:
			answers = []string{value}
		case []string:
			answers = value
		case []any:
			answers, _ = stringSlice(value)
		}
		shown := make([]string, 0, len(answers))
		for _, value := range answers {
			for _, option := range question.Options {
				if option.ID == value {
					value = option.Label
				}
			}
			shown = append(shown, value)
		}
		text.WriteString("\n- " + question.Prompt + " → " + strings.Join(shown, ", "))
	}
	if answer.Comment != "" {
		text.WriteString("\nComment: " + answer.Comment)
	}
	return text.String()
}
