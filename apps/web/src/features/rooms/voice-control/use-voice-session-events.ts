import { useEffect } from "react";

import type { TeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubVoiceTranscriptEventPage } from "@/features/teamhub/teamhub-types";

import {
  isActiveCapture,
  mergeVoiceTranscriptItems,
} from "./voice-control-helpers";
import type { VoiceControlState } from "./use-voice-control-state";

const partialTranscriptStaleMs = 10_000;

/**
 * Subscribes to the VoiceSession's event feed and projects its Captures,
 * session state and transcript pages into the provider.
 */
export function useVoiceSessionEvents(
  state: VoiceControlState,
  runtime: TeamHubRuntime,
  cleanupMedia: () => Promise<void>,
) {
  const {
    refs,
    setCapture,
    setListenerError,
    setListenerStatus,
    setPartialTranscript,
    setTranscriptItems,
    setTranscriptStatus,
    voiceSessionId,
  } = state;

  useEffect(() => {
    if (!voiceSessionId) {
      setTranscriptStatus("idle");
      return;
    }
    let active = true;
    const projector = createVoiceTranscriptProjector(
      { refs, setPartialTranscript, setTranscriptItems, setTranscriptStatus },
      () => active,
    );
    setTranscriptStatus("live");
    refs.eventStreamLiveRef.current = false;
    refs.voiceAccessLostRef.current = false;
    const unsubscribe = runtime.voiceEvents?.subscribe({
      voiceSessionId,
      onTranscriptPage: (page) => projector.project(page),
      onEvents: (page) => {
        if (!active) return;
        for (const event of page.items) {
          if (event.capture?.voice_session_id === voiceSessionId) {
            const capture = event.capture;
            const current = refs.captureRef.current;
            if (
              capture.id === current?.id ||
              (isActiveCapture(capture) &&
                (!current ||
                  Date.parse(capture.created_at) >
                    Date.parse(current.created_at)))
            ) {
              setCapture(capture);
            }
          }
          if (
            event.session &&
            event.session.id === refs.voiceSessionRef.current?.id
          ) {
            refs.voiceSessionRef.current = {
              ...refs.voiceSessionRef.current,
              ...event.session,
            };
            if (event.session.status === "closed") {
              refs.manuallyDisabledRef.current = true;
              setListenerStatus("disabled");
              void cleanupMedia();
              refs.publisherLeaseRef.current?.();
              refs.publisherLeaseRef.current = undefined;
            }
          }
          if (event.transcript?.voice_session_id === voiceSessionId)
            projector.project({ items: [event.transcript] }, false);
        }
      },
      onMode: (mode) => {
        if (!active) return;
        if (mode === "sse" && !refs.eventStreamLiveRef.current)
          refs.captureResyncRef.current = true;
        refs.eventStreamLiveRef.current = mode === "sse";
        setTranscriptStatus(mode === "recovering" ? "recovering" : "live");
      },
      onAccessLost: () => {
        if (!active) return;
        refs.eventStreamLiveRef.current = false;
        refs.voiceAccessLostRef.current = true;
        setTranscriptStatus("idle");
        setListenerError(
          "Voice session access has expired. Sign in again or check your access to the target Agent.",
        );
        setListenerStatus("error");
        void cleanupMedia();
        refs.publisherLeaseRef.current?.();
        refs.publisherLeaseRef.current = undefined;
      },
    });
    return () => {
      unsubscribe?.();
      refs.eventStreamLiveRef.current = false;
      active = false;
      projector.dispose();
    };
  }, [
    cleanupMedia,
    refs,
    runtime.voiceEvents,
    setCapture,
    setListenerError,
    setListenerStatus,
    setPartialTranscript,
    setTranscriptItems,
    setTranscriptStatus,
    voiceSessionId,
  ]);
}

/**
 * Projects transcript pages of one subscription: final items merge into the
 * transcript and the partial hypothesis shows until it is closed or stale.
 */
function createVoiceTranscriptProjector(
  {
    refs,
    setPartialTranscript,
    setTranscriptItems,
    setTranscriptStatus,
  }: Pick<
    VoiceControlState,
    | "refs"
    | "setPartialTranscript"
    | "setTranscriptItems"
    | "setTranscriptStatus"
  >,
  isActive: () => boolean,
) {
  let partialTimer: number | undefined;
  let partialCaptureId = refs.captureRef.current?.id;
  let partialEndWatermark = -1;
  let closedPartialEnd = -1;
  let lastPartial:
    | {
        captureId: string | undefined;
        text: string;
        startOffsetMs: number | undefined;
        endOffsetMs: number | undefined;
      }
    | undefined;
  const project = (
    page: TeamHubVoiceTranscriptEventPage,
    includePartial = true,
  ) => {
    if (!isActive() || !refs.mountedRef.current) return;
    setTranscriptStatus("live");
    const capture = refs.captureRef.current;
    const captureStart = capture?.requested_start_offset_ms ?? 0;
    if (partialCaptureId !== capture?.id) {
      window.clearTimeout(partialTimer);
      partialCaptureId = capture?.id;
      partialEndWatermark = -1;
      closedPartialEnd = -1;
      lastPartial = undefined;
    }
    for (const event of page.items) {
      if (event.capture_session_id === capture?.id)
        closedPartialEnd = Math.max(closedPartialEnd, event.end_offset_ms);
    }
    if (
      lastPartial?.endOffsetMs !== undefined &&
      lastPartial.endOffsetMs <= closedPartialEnd
    ) {
      window.clearTimeout(partialTimer);
      setPartialTranscript(undefined);
    }
    if (includePartial) {
      const partial =
        !capture ||
        (isActiveCapture(capture) &&
          (page.partial_end_offset_ms !== undefined
            ? page.partial_end_offset_ms > captureStart
            : page.partial_start_offset_ms === undefined ||
              page.partial_start_offset_ms >= captureStart))
          ? page.partial_transcript
          : undefined;
      if (!partial) {
        window.clearTimeout(partialTimer);
        closedPartialEnd = Math.max(closedPartialEnd, partialEndWatermark);
        setPartialTranscript(undefined);
      } else if (
        (page.partial_end_offset_ms === undefined ||
          (page.partial_end_offset_ms >= partialEndWatermark &&
            page.partial_end_offset_ms > closedPartialEnd)) &&
        (lastPartial?.captureId !== capture?.id ||
          lastPartial?.text !== partial ||
          lastPartial?.startOffsetMs !== page.partial_start_offset_ms ||
          lastPartial?.endOffsetMs !== page.partial_end_offset_ms)
      ) {
        const observed = {
          captureId: capture?.id,
          text: partial,
          startOffsetMs: page.partial_start_offset_ms,
          endOffsetMs: page.partial_end_offset_ms,
        };
        if (observed.endOffsetMs !== undefined)
          partialEndWatermark = Math.max(
            partialEndWatermark,
            observed.endOffsetMs,
          );
        lastPartial = observed;
        window.clearTimeout(partialTimer);
        setPartialTranscript(partial);
        // HTTP success can repeat a stalled hypothesis. Only observed
        // text or offset progress renews its temporary display lifetime.
        partialTimer = window.setTimeout(() => {
          if (
            isActive() &&
            refs.mountedRef.current &&
            lastPartial === observed &&
            refs.captureRef.current?.id === observed.captureId
          )
            setPartialTranscript(undefined);
        }, partialTranscriptStaleMs);
      }
    }
    if (page.items.length === 0) return;
    setTranscriptItems((current) =>
      mergeVoiceTranscriptItems(current, page.items),
    );
  };
  return {
    project,
    dispose: () => window.clearTimeout(partialTimer),
  };
}
