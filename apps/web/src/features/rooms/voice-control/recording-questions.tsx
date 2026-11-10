import {
  ArrowUp02Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubVoiceCaptureQuestion } from "@/features/teamhub/teamhub-types";
import { formatRecordingTime } from "./recording-time";
import styles from "./voice-focus.module.css";

const questionsKey = (captureId: string) =>
  ["teamhub", "voice-capture-questions", captureId] as const;

interface Pending {
  question: string;
  failed: boolean;
}

/** How sending a task request to Another Me is going. */
export type AskTaskState = "sending" | "sent" | "failed";

/**
 * The recording's Agent in Ask. A question is answered from what was
 * confirmed when it was asked, so answers stay put as the meeting goes on; a
 * request for Another Me is handed to it right away, and Another Me decides on
 * the background Task. Asking never pauses or changes the recording.
 */
export function useRecordingQuestions(captureId: string | undefined) {
  const { client } = useTeamHubRuntime();
  const owner = useMemo(() => ({ captureId, client }), [captureId, client]);
  const queryClient = useQueryClient();
  const asked = useQuery({
    enabled: Boolean(captureId),
    queryKey: questionsKey(captureId ?? ""),
    queryFn: ({ signal }) =>
      teamHubData(
        client.api.GET("/v0/voice-captures/{captureSessionId}/questions", {
          params: { path: { captureSessionId: captureId! } },
          signal,
        }),
      ),
  });
  const [request, setRequest] = useState<Pending & { owner: typeof owner }>();
  const pending = request?.owner === owner ? request : undefined;
  // Question IDs are globally unique. Track each send independently so a
  // late response from an older recording cannot reset the current one.
  const [sendingStates, setSending] = useState<
    Record<string, "sending" | "failed">
  >({});
  const markSending = (id: string, state?: "sending" | "failed") =>
    setSending((current) => {
      const states = { ...current };
      if (state) states[id] = state;
      else delete states[id];
      return states;
    });
  const keep = async (item: TeamHubVoiceCaptureQuestion) => {
    if (!captureId) return;
    // A list still loading must not overwrite what just arrived.
    await queryClient.cancelQueries({ queryKey: questionsKey(captureId) });
    queryClient.setQueryData<{ items: TeamHubVoiceCaptureQuestion[] }>(
      questionsKey(captureId),
      (current) => {
        const items = current?.items ?? [];
        return items.some((each) => each.id === item.id)
          ? { items: items.map((each) => (each.id === item.id ? item : each)) }
          : { items: [...items, item] };
      },
    );
    void queryClient.invalidateQueries({ queryKey: questionsKey(captureId) });
  };
  const sendTask = async (id: string) => {
    if (!captureId) return;
    markSending(id, "sending");
    try {
      await keep(
        await teamHubData(
          client.api.POST(
            "/v0/voice-captures/{captureSessionId}/questions/{questionId}/task",
            {
              params: { path: { captureSessionId: captureId, questionId: id } },
            },
          ),
        ),
      );
      markSending(id);
    } catch {
      markSending(id, "failed");
    }
  };
  const ask = async (question: string) => {
    if (!captureId) return;
    const current = { owner, question, failed: false };
    setRequest(current);
    try {
      const answer = await teamHubData(
        client.api.POST("/v0/voice-captures/{captureSessionId}/questions", {
          params: { path: { captureSessionId: captureId } },
          body: { question },
        }),
      );
      // The recording's Agent recognized a request: hand it over now.
      const send = answer.kind === "task" && !answer.sent_message_id;
      if (send) markSending(answer.id, "sending");
      await keep(answer);
      setRequest((latest) => (latest === current ? undefined : latest));
      if (send) void sendTask(answer.id);
    } catch {
      setRequest((latest) =>
        latest === current ? { ...current, failed: true } : latest,
      );
    }
  };
  return {
    items: captureId ? (asked.data?.items ?? []) : [],
    pending,
    /** A task request's state; undefined for an answer. */
    taskState: (item: TeamHubVoiceCaptureQuestion): AskTaskState | undefined =>
      item.kind !== "task"
        ? undefined
        : item.sent_message_id
          ? "sent"
          : (sendingStates[item.id] ?? "failed"),
    ask: (question: string) => void ask(question),
    retry: () => pending && void ask(pending.question),
    retryTask: (id: string) => void sendTask(id),
  };
}

export function RecordingAskBox({
  busy,
  onAsk,
}: {
  busy: boolean;
  onAsk: (question: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const send = () => {
    const text = question.trim();
    if (!text || busy) return;
    onAsk(text);
    setQuestion("");
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    send();
  };
  return (
    // Shares the window's gutter with the answers above.
    <div className="mx-4 mt-2 mb-4 flex shrink-0 items-end gap-2 rounded-2xl bg-app-surface py-1 pr-1 pl-3 shadow-(--composer-shadow) transition-shadow focus-within:shadow-(--composer-shadow-focus)">
      <textarea
        aria-label="Ask about this recording"
        className="max-h-24 min-h-7 flex-1 resize-none self-center bg-transparent py-1 text-sm leading-5 text-app-ink [field-sizing:content] placeholder:text-app-muted focus:outline-none"
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={onKey}
        placeholder="Ask something or ask to do something"
        rows={1}
        value={question}
      />
      <Button
        aria-label="Send question"
        className="!size-7 !rounded-full"
        disabled={busy || !question.trim()}
        onClick={send}
        size="compactIcon"
        tone="primary"
      >
        <Icon icon={ArrowUp02Icon} size={16} />
      </Button>
    </div>
  );
}

const bubble =
  "max-w-[85%] self-end rounded-[12px_12px_4px_12px] bg-app-surface-soft px-2.5 py-1.5 text-sm leading-5 text-app-ink";

export function RecordingAnswers({
  items,
  onRetry,
  onRetryTask,
  pending,
  recordingStartMs,
  taskState,
}: {
  items: TeamHubVoiceCaptureQuestion[];
  onRetry: () => void;
  onRetryTask: (id: string) => void;
  pending?: Pending;
  /** Session offset where this recording began, to show recording times. */
  recordingStartMs: number;
  taskState: (item: TeamHubVoiceCaptureQuestion) => AskTaskState | undefined;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const followingRef = useRef(true);
  const previousQuestionRef = useRef<string | undefined>(undefined);
  const latestId = items.at(-1)?.id;
  useLayoutEffect(() => {
    const list = listRef.current;
    const newQuestion =
      pending?.question !== undefined &&
      pending.question !== previousQuestionRef.current;
    previousQuestionRef.current = pending?.question;
    if (!list) return;
    if (newQuestion) followingRef.current = true;
    if (followingRef.current) list.scrollTop = list.scrollHeight;
  }, [latestId, pending?.question]);
  const at = (offsetMs: number) =>
    formatRecordingTime(offsetMs - recordingStartMs);
  return (
    <ol
      aria-label="Answers about this recording"
      aria-live="polite"
      className="workspace-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3"
      ref={listRef}
      onScroll={(event) => {
        const list = event.currentTarget;
        followingRef.current =
          list.scrollHeight - list.scrollTop - list.clientHeight <= 2;
      }}
    >
      {items.length || pending ? null : (
        <li className="m-auto max-w-[32ch] py-6 text-center text-[12px] leading-[18px] text-app-muted">
          Ask what was said, decided, or left open, or ask Another Me to do
          something, like drafting a follow-up email.
        </li>
      )}
      {items.map((item) => {
        const state = taskState(item);
        return (
          <li className="flex flex-col gap-1.5" key={item.id}>
            <p className={bubble}>{item.question}</p>
            {state ? (
              <AskTaskStatus
                onRetry={() => onRetryTask(item.id)}
                state={state}
              />
            ) : (
              <>
                <p
                  className={`whitespace-pre-wrap text-sm leading-5 ${
                    item.answered ? "text-app-body" : "text-app-muted"
                  }`}
                >
                  {item.answer}
                </p>
                <p className="text-[12px] leading-[18px] text-app-muted">
                  Based on the recording up to {at(item.cutoff_offset_ms)}
                </p>
              </>
            )}
          </li>
        );
      })}
      {pending ? (
        <li className="flex flex-col gap-1.5">
          <p className={bubble}>{pending.question}</p>
          {pending.failed ? (
            <p
              className="flex items-center gap-2 text-[12px] leading-[18px] text-app-danger"
              role="alert"
            >
              The answer could not be generated.
              <Button onClick={onRetry} size="compact" tone="ghost">
                Retry
              </Button>
            </p>
          ) : (
            <p className="flex items-center gap-2 text-[12px] leading-[18px] text-app-muted">
              <Icon icon={Loading03Icon} className="animate-spin" size={14} />
              Answering…
            </p>
          )}
        </li>
      ) : null}
    </ol>
  );
}

/** A request handed to Another Me: sending, sent, or failed. */
function AskTaskStatus({
  onRetry,
  state,
}: {
  onRetry: () => void;
  state: AskTaskState;
}) {
  return (
    <div className="flex items-center gap-2" data-task-state={state}>
      <TaskNode state={state} />
      {state === "sending" ? (
        <span
          className="text-[12px] leading-[18px] text-app-muted"
          role="status"
        >
          Sending to Another Me…
        </span>
      ) : state === "failed" ? (
        <span
          className="flex items-center gap-1 text-[12px] leading-[18px] text-app-danger"
          role="status"
        >
          {"Not sent · "}
          <button
            className="font-medium underline-offset-2 hover:underline"
            onClick={onRetry}
            type="button"
          >
            Retry
          </button>
        </span>
      ) : (
        <span
          className="text-[12px] leading-[18px] text-app-muted"
          role="status"
        >
          Sent to Another Me
        </span>
      )}
    </div>
  );
}

/** The request's node: a spinner while sending, then a green check or red ring. */
function TaskNode({ state }: { state: AskTaskState }) {
  const base = "relative shrink-0 rounded-full";
  switch (state) {
    case "sending":
      return (
        <span
          className={`${base} size-[11px] animate-spin border-[1.5px] border-app-border-strong border-t-app-ink bg-app-surface motion-reduce:animate-none`}
          data-node="sending"
        />
      );
    case "sent":
      return (
        <span
          className={`${base} ${styles.taskSent} inline-flex size-[14px] items-center justify-center bg-app-success text-white`}
          data-node="sent"
        >
          <span className={`inline-flex ${styles.taskSentCheck}`}>
            <Icon icon={Tick02Icon} size={10} />
          </span>
        </span>
      );
    case "failed":
      return (
        <span
          className={`${base} size-[9px] border-[1.5px] border-app-danger bg-app-surface`}
          data-node="failed"
        />
      );
  }
}
