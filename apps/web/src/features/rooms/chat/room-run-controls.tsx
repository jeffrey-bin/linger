import { useMutation, useMutationState } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { createTeamHubIdempotencyKey } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubRoomRunCancelResult,
  TeamHubRoomRunRedeliverResult,
} from "@/features/teamhub/teamhub-types";

interface StopVariables {
  requestId: string;
  runId: string;
}

/**
 * Stops one Run. The state is shared by Agent within the Room or Thread, so a
 * stop in flight survives the status line rotating away and back.
 */
export function AgentRunStopButton({
  name,
  controlKey,
  runId,
  cancel,
  scopeKey,
}: {
  name: string;
  controlKey: string;
  runId: string;
  cancel: (requestId: string) => Promise<TeamHubRoomRunCancelResult>;
  /** The Room or Thread whose Stop state this button shares. */
  scopeKey: readonly string[];
}) {
  const [requestId] = useState(createTeamHubIdempotencyKey);
  const mutationKey = ["room-stop", ...scopeKey, controlKey];
  const previous = useMutationState({
    filters: {
      mutationKey,
      exact: true,
      predicate: (item) =>
        (item.state.variables as StopVariables | undefined)?.runId === runId,
    },
    select: (item) => item.state,
  }).at(-1);
  const mutation = useMutation({
    mutationKey,
    mutationFn: (variables: StopVariables) => cancel(variables.requestId),
    // The Run status that the Stop ends arrives on the event stream.
    retry: false,
  });
  const state = previous ?? mutation;
  const result = state.data as TeamHubRoomRunCancelResult | undefined;
  const stopping =
    state.status === "pending" || result?.status === "cancel_requested";
  const stopped =
    result?.status === "canceled" || result?.status === "already_terminal";
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1">
      <Button
        type="button"
        tone="ghost"
        size="compact"
        className="h-7 px-1.5 text-[12px] font-medium text-app-muted hover:bg-transparent hover:text-app-danger"
        disabled={stopping || stopped}
        onClick={() =>
          mutation.mutate({
            requestId:
              previous?.status === "error"
                ? (previous.variables as StopVariables).requestId
                : requestId,
            runId,
          })
        }
        aria-label={`Stop ${name}'s task`}
      >
        {stopping ? "Stopping" : stopped ? "Stopped" : "Stop"}
      </Button>
      {state.status === "error" ? (
        <span
          role="alert"
          className="max-w-28 truncate text-[12px] text-app-danger"
        >
          Stop not confirmed. Check the task status, then retry.
        </span>
      ) : null}
    </span>
  );
}

/**
 * Resends a finished Run's unconfirmed follow-ups to the same Agent. Like
 * Stop, its state is shared by Agent within the Room or Thread, so a resend
 * in flight or its outcome survives the status line rotating away and back. TeamHub
 * resends each follow-up at most once, so a retry after an error is safe.
 */
export function AgentRunResendButton({
  name,
  controlKey,
  runId,
  redeliver,
  scopeKey,
}: {
  name: string;
  controlKey: string;
  runId: string;
  redeliver: () => Promise<TeamHubRoomRunRedeliverResult>;
  /** The Room or Thread whose Resend state this button shares. */
  scopeKey: readonly string[];
}) {
  const mutationKey = ["room-resend", ...scopeKey, controlKey];
  const previous = useMutationState({
    filters: {
      mutationKey,
      exact: true,
      predicate: (item) => item.state.variables === runId,
    },
    select: (item) => item.state,
  }).at(-1);
  const mutation = useMutation({
    mutationKey,
    mutationFn: (_runId: string) => redeliver(),
    retry: false,
  });
  const state = previous ?? mutation;
  const result = state.data as TeamHubRoomRunRedeliverResult | undefined;
  // The resent follow-up's Run replaces this row only once it is claimed,
  // so the outcome stays in place of the button until then.
  if (result)
    return (
      <span className="shrink-0 px-1.5 text-[12px] font-medium text-app-subtle">
        {result.status === "redelivered" ? "Resent" : "Nothing to resend"}
      </span>
    );
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1">
      <Button
        type="button"
        tone="ghost"
        size="compact"
        className="h-7 px-1.5 text-[12px] font-medium text-app-muted hover:bg-transparent hover:text-app-ink"
        disabled={state.status === "pending"}
        onClick={() => mutation.mutate(runId)}
        aria-label={`Resend unconfirmed follow-up to ${name}`}
      >
        Resend
      </Button>
      {state.status === "error" ? (
        <span
          role="alert"
          className="max-w-28 truncate text-[12px] text-app-danger"
        >
          Resend failed. Try again.
        </span>
      ) : null}
    </span>
  );
}
