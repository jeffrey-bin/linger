import { useId, useLayoutEffect, useRef } from "react";

import { roomDiagnosticsEnabled } from "@/lib/room-diagnostics";

interface RenderIdentity {
  roomId?: string;
  messageId?: string;
  runStatusIds?: readonly string[];
  runIds?: readonly string[];
  result: "rendered" | "working" | "stopped";
}

// Observe the existing render only. No state update, subscription or terminal decision.
// With diagnostics off it does no work: no serialization, no frames, no logs.
export function useRoomRenderTiming(
  surface: "message" | "dock" | "room_list",
  identity: RenderIdentity | null,
  contentRevision?: string,
) {
  const surfaceId = useId();
  const previous = useRef<RenderIdentity | null>(null);
  const encoded = roomDiagnosticsEnabled() ? JSON.stringify(identity) : "null";
  useLayoutEffect(() => {
    const current = JSON.parse(encoded) as RenderIdentity | null;
    if (!current) return;
    const prior = previous.current;
    previous.current = current;
    const record = (phase: "dom_committed" | "after_animation_frames") => {
      console.debug("room.render_timing", {
        surface,
        surfaceId,
        ...current,
        previous: prior,
        phase,
        observedAtUnixMs: Date.now(),
        observedAtMonotonicMs: performance.now(),
        timeOrigin: performance.timeOrigin,
        visibility: document.visibilityState,
      });
    };
    record("dom_committed");
    // Two frames provide a visible-page paint opportunity, not GPU pixel proof.
    let secondFrame: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() =>
        record("after_animation_frames"),
      );
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, [encoded, surface, surfaceId, contentRevision]);
}
