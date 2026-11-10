package native

import (
	"encoding/json"
	"strconv"
)

// Codex native question mapping. The Codex adapter owns the wire handling of
// item/tool/requestUserInput; these helpers turn its questions into a Room
// question card and the human's decision back into Codex answers.

const (
	codexQuestionPrompt        = "Answer the Agent's question"
	codexSecretQuestionCode    = -32602
	codexSecretQuestionMessage = "Secret questions cannot be posted to a shared Room"
	codexQuestionRefusedCode   = -32603

	codexUnansweredQuestionMessage = "No one can answer a question here. Continue with what you can do and put the question in your final reply; the Meta decides whether to ask a person."
)

type codexQuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

type codexQuestion struct {
	ID       string                `json:"id"`
	Header   string                `json:"header"`
	Question string                `json:"question"`
	IsOther  bool                  `json:"isOther"`
	IsSecret bool                  `json:"isSecret"`
	Options  []codexQuestionOption `json:"options"`
}

// codexQuestionRequest builds the bridge request for native questions. It
// returns false when any question is secret: secrets never reach a Room.
func codexQuestionRequest(questions []codexQuestion) (map[string]any, bool) {
	form := make([]any, 0, len(questions))
	for _, question := range questions {
		if question.IsSecret {
			return nil, false
		}
		item := map[string]any{"id": question.ID, "prompt": question.Question, "input": "text"}
		switch {
		case question.IsOther:
			prompt := question.Question
			for _, option := range question.Options {
				prompt += "\n" + option.Label + ": " + option.Description
			}
			item["prompt"] = prompt
		case len(question.Options) > 0:
			options := make([]any, 0, len(question.Options))
			for index, option := range question.Options {
				// Short index ids keep provider labels out of the form's ids.
				options = append(options, map[string]any{"id": strconv.Itoa(index), "label": option.Label})
			}
			item["input"] = "radio"
			item["options"] = options
		}
		form = append(form, item)
	}
	return map[string]any{
		"kind":   "native_question",
		"prompt": codexQuestionPrompt,
		"form":   map[string]any{"type": "questions", "questions": form},
	}, true
}

// codexQuestionRequestID names the bridge request after the raw JSON-RPC id
// text, so a string id keeps its quotes.
func codexQuestionRequestID(rawID json.RawMessage) string {
	return "codex-" + string(rawID)
}

// codexQuestionAnswers maps a Room decision to the requestUserInput result.
// Any decision other than submit answers every question with nothing.
func codexQuestionAnswers(questions []codexQuestion, payload json.RawMessage) (map[string]any, error) {
	var decision struct {
		Decision string            `json:"decision"`
		Answers  map[string]string `json:"answers"`
	}
	if err := json.Unmarshal(payload, &decision); err != nil {
		return nil, err
	}
	answers := make(map[string]any, len(questions))
	for _, question := range questions {
		if decision.Decision != "submit" {
			answers[question.ID] = map[string]any{"answers": []string{}}
			continue
		}
		answer := decision.Answers[question.ID]
		if !question.IsOther {
			if index, err := strconv.Atoi(answer); err == nil && index >= 0 && index < len(question.Options) && strconv.Itoa(index) == answer {
				answer = question.Options[index].Label
			}
		}
		answers[question.ID] = map[string]any{"answers": []string{answer}}
	}
	return map[string]any{"answers": answers}, nil
}

// questionTurnEnded refuses an answer whose original turn is gone.
func questionTurnEnded() *SteerError {
	return &SteerError{Effect: "definitely_not_applied", Reason: "no_active_turn", Message: "Original question turn has ended"}
}
