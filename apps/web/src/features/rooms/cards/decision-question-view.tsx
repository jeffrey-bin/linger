import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

import { AutoHeight } from "@/components/ui/auto-height";

import { CardBox, CardHeading } from "./card-shell";

import type { DecisionMessageCard } from "./decision-card";
import type { RoomCardDecision } from "./room-message-card-contract";

type InteractionQuestion = NonNullable<
  DecisionMessageCard["question"]
>["questions"][number];
type AnswerMap = Record<string, string | string[]>;

/** How long a chosen option stays lit before the card moves on. */
const choiceBeatMs = 140;

/**
 * A question card for its decision owner: the question as the card's bold
 * heading and its options as rows, one question at a time, with an "Other…"
 * row for an answer of their own. An open question is asked in a message
 * instead. Once settled,
 * the chat shows the answers as system lines and the card is gone.
 */
export function QuestionDecision({
  card,
  currentActorId,
  messageId,
  onDecision,
}: {
  card: DecisionMessageCard;
  currentActorId?: string;
  messageId: string;
  onDecision: (decision: RoomCardDecision) => Promise<void> | void;
}) {
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [stepIndex, setStepIndex] = useState(0);
  // Fade a step in only once the card has moved, not when it first shows.
  const [stepped, setStepped] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const pending = card.status === "pending";
  const canDecide = pending && currentActorId === card.decision_owner.id;
  const questions: InteractionQuestion[] = card.question?.questions ?? [];
  const activeQuestion = questions[stepIndex];
  const isFinalStep = stepIndex >= questions.length - 1;

  async function submit(nextAnswers: AnswerMap = answers) {
    setDecisionError(null);
    setSubmitting(true);
    try {
      await onDecision({
        answers: nextAnswers,
        decision: "submit",
        expectedVersion: card.version,
        messageId,
        requestId: card.decision_id,
      });
    } catch (error) {
      setDecisionError(
        error instanceof Error ? error.message : "Card decision failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  // The chosen row lights up for a beat before the card moves on.
  function selectRadio(question: InteractionQuestion, optionId: string) {
    const nextAnswers = { ...answers, [question.id]: optionId };
    setAnswers(nextAnswers);
    window.setTimeout(() => {
      if (isFinalStep) {
        void submit(nextAnswers);
        return;
      }
      goToStep(stepIndex + 1);
    }, choiceBeatMs);
  }

  function goToStep(next: number) {
    setStepped(true);
    setStepIndex(Math.max(0, Math.min(next, questions.length - 1)));
  }

  function toggleCheckbox(question: InteractionQuestion, optionId: string) {
    const current = Array.isArray(answers[question.id])
      ? (answers[question.id] as string[])
      : [];
    setAnswers({
      ...answers,
      [question.id]: current.includes(optionId)
        ? current.filter((value) => value !== optionId)
        : [...current, optionId],
    });
  }

  // A written answer replaces a radio choice and joins checkbox choices.
  function writeAnswer(question: InteractionQuestion, text: string) {
    if (question.input !== "checkbox") {
      setAnswers({ ...answers, [question.id]: text });
      return;
    }
    const current = answers[question.id];
    const chosen = (Array.isArray(current) ? current : []).filter((item) =>
      isOptionId(question, item),
    );
    setAnswers({
      ...answers,
      [question.id]: text.trim() ? [...chosen, text] : chosen,
    });
  }

  if (!pending || !activeQuestion) return null;
  const value = answers[activeQuestion.id];
  const checkbox = activeQuestion.input === "checkbox";
  const written = writtenAnswer(activeQuestion, value).trim() !== "";

  return (
    <CardBox label="Human interaction requested">
      <AutoHeight>
        <div className={stepped ? "card-step-in" : undefined} key={stepIndex}>
          <CardHeading>{activeQuestion.prompt}</CardHeading>
          <div className="flex flex-col">
            {(activeQuestion.options ?? []).map((option) => (
              <ChoiceRow
                // A single choice moves on at once, so only multiple choices
                // keep a check.
                check={checkbox}
                disabled={submitting || !canDecide}
                key={option.id}
                onSelect={
                  canDecide
                    ? () =>
                        checkbox
                          ? toggleCheckbox(activeQuestion, option.id)
                          : selectRadio(activeQuestion, option.id)
                    : undefined
                }
                selected={
                  Array.isArray(value)
                    ? value.includes(option.id)
                    : value === option.id
                }
              >
                {option.label}
              </ChoiceRow>
            ))}
            {canDecide ? (
              <OtherRow
                disabled={submitting}
                key={activeQuestion.id}
                onWrite={(text) => writeAnswer(activeQuestion, text)}
                question={activeQuestion}
                value={writtenAnswer(activeQuestion, value)}
              />
            ) : null}
          </div>
        </div>
        {canDecide && (questions.length > 1 || checkbox || written) ? (
          <div className="flex items-center justify-between gap-2 pt-1 pb-1.5">
            <div className="flex items-center gap-0.5 text-xs text-app-muted">
              {questions.length > 1 ? (
                <>
                  <button
                    aria-label="Previous question"
                    className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-app-ink disabled:opacity-35"
                    disabled={stepIndex === 0 || submitting}
                    onClick={() => goToStep(stepIndex - 1)}
                    type="button"
                  >
                    <Icon icon={ArrowLeft01Icon} size={14} />
                  </button>
                  <span className="tabular-nums">
                    {stepIndex + 1} / {questions.length}
                  </span>
                  <button
                    aria-label="Next question"
                    className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted hover:text-app-ink disabled:opacity-35"
                    disabled={
                      submitting ||
                      isFinalStep ||
                      !hasAnswer(activeQuestion, value)
                    }
                    onClick={() => goToStep(stepIndex + 1)}
                    type="button"
                  >
                    <Icon icon={ArrowRight01Icon} size={14} />
                  </button>
                </>
              ) : checkbox ? (
                <span>Choose any</span>
              ) : null}
            </div>
            {checkbox || written ? (
              <Button
                disabled={submitting || !hasAnswer(activeQuestion, value)}
                onClick={() => {
                  if (isFinalStep) {
                    void submit();
                    return;
                  }
                  goToStep(stepIndex + 1);
                }}
                size="default"
                tone="primary"
              >
                {isFinalStep ? "Send" : "Next"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {decisionError ? (
          <p className="pb-1.5 text-xs text-app-danger">{decisionError}</p>
        ) : null}
      </AutoHeight>
    </CardBox>
  );
}

/**
 * The "Other…" row: a muted row that becomes a field for the Human's own
 * answer once clicked, in place of a radio choice or beside checkbox picks.
 */
function OtherRow({
  disabled,
  onWrite,
  question,
  value,
}: {
  disabled?: boolean;
  onWrite: (text: string) => void;
  question: InteractionQuestion;
  value: string;
}) {
  const [writing, setWriting] = useState(value !== "");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (writing) field.current?.focus();
  }, [writing]);
  if (!writing) {
    return (
      <button
        className="question-choice question-choice-other"
        disabled={disabled}
        onClick={() => setWriting(true)}
        type="button"
      >
        Other…
      </button>
    );
  }
  return (
    <label className="question-choice question-choice-writing">
      <input
        aria-label={`Your own answer to ${question.prompt}`}
        className="min-w-0 flex-1 bg-transparent text-sm text-app-ink outline-none placeholder:text-app-muted"
        disabled={disabled}
        maxLength={question.input === "checkbox" ? 200 : 10000}
        onChange={(event) => onWrite(event.target.value)}
        placeholder="Your own answer"
        ref={field}
        value={value}
      />
    </label>
  );
}

function isOptionId(question: InteractionQuestion, value: string) {
  return (question.options ?? []).some((option) => option.id === value);
}

/** The part of an answer that names no option: the Human's own words. */
function writtenAnswer(
  question: InteractionQuestion,
  value: string | string[] | undefined,
) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.find((item) => !isOptionId(question, item)) ?? "";
}

/**
 * An option is a full-width row that tints under the pointer; on a multiple
 * choice question a check marks it chosen.
 */
function ChoiceRow({
  check,
  children,
  disabled,
  onSelect,
  selected,
}: {
  /** Mark a chosen row with a check; only multiple-choice picks stay. */
  check: boolean;
  children: string;
  disabled?: boolean;
  onSelect?: () => void;
  selected: boolean;
}) {
  const className = `question-choice ${selected ? "question-choice-selected" : ""}`;
  const content = (
    <>
      <span className="min-w-0">{children}</span>
      {check && selected ? (
        <Icon className="question-choice-check" icon={Tick02Icon} size={16} />
      ) : null}
    </>
  );
  if (!onSelect) {
    return (
      <div className={`${className} question-choice-readonly`}>{content}</div>
    );
  }
  return (
    <button
      aria-pressed={selected}
      className={className}
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      {content}
    </button>
  );
}

function hasAnswer(
  question: InteractionQuestion,
  value: string | string[] | undefined,
) {
  return question.input === "checkbox"
    ? Array.isArray(value) && value.length > 0
    : typeof value === "string" && value.trim() !== "";
}
