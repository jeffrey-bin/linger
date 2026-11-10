import { useCallback } from "react";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import type { TeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { isActiveCapture } from "./voice-control-helpers";
import {
  readSelectedVoiceRoom,
  writeSelectedVoiceRoom,
} from "./voice-control-storage";
import type { VoiceControlState } from "./use-voice-control-state";

/** Resolves the recording target Room and its hardware VoiceSession. */
export function useVoiceTarget(
  state: VoiceControlState,
  runtime: TeamHubRuntime,
  tenantId: string,
  activeRoomId: string | undefined,
) {
  const { refs, setTargetAgentName, setTargetRoomId } = state;

  const ensureTarget = useCallback(
    async (activeRoomOverride?: string) => {
      await refs.targetChangeRef.current;
      if (
        refs.targetRef.current &&
        (!activeRoomOverride ||
          refs.targetRef.current.roomId === activeRoomOverride)
      )
        return refs.targetRef.current;
      const selectedRoomId =
        activeRoomOverride ?? activeRoomId ?? readSelectedVoiceRoom(tenantId);
      if (selectedRoomId) {
        const room = await teamHubData(
          runtime.client.api.GET("/v0/rooms/{roomId}", {
            params: { path: { roomId: selectedRoomId } },
          }),
        );
        if (room.kind !== "direct" || room.direct_peer?.kind !== "agent")
          throw new Error(
            "Select the recording target again in the Agent direct chat",
          );
        if (refs.targetRef.current && !activeRoomOverride)
          return refs.targetRef.current;
        const resolved = {
          roomId: room.id,
          agentId: room.direct_peer.id,
          agentName: room.direct_peer.display_name,
        };
        refs.targetRef.current = resolved;
        setTargetRoomId(resolved.roomId);
        setTargetAgentName(resolved.agentName);
        return resolved;
      }
      const target = await teamHubData(
        runtime.client.api.GET("/v0/tenants/{tenantId}/another-me", {
          params: { path: { tenantId } },
        }),
      );
      if (!target.agent_actor_id || !target.room_id) {
        throw new Error("Your AnotherMe is not ready for recording");
      }
      const actor = await teamHubData(
        runtime.client.api.GET("/v0/tenants/{tenantId}/actors/{actorId}", {
          params: { path: { tenantId, actorId: target.agent_actor_id } },
        }),
      );
      const resolved = {
        agentId: target.agent_actor_id,
        agentName: actor.display_name,
        roomId: target.room_id,
      };
      if (refs.targetRef.current) return refs.targetRef.current;
      refs.targetRef.current = resolved;
      setTargetAgentName(resolved.agentName);
      setTargetRoomId(resolved.roomId);
      return resolved;
    },
    [
      activeRoomId,
      refs,
      runtime.client,
      setTargetAgentName,
      setTargetRoomId,
      tenantId,
    ],
  );

  const resolveVoiceSession = useCallback(
    async (roomId: string) => {
      try {
        return await teamHubData(
          runtime.client.api.GET("/v0/rooms/{roomId}/voice-sessions", {
            params: { path: { roomId } },
          }),
        );
      } catch (error) {
        if (!(error instanceof TeamHubError) || error.status !== 404)
          throw error;
      }
      return teamHubData(
        runtime.client.api.POST("/v0/rooms/{roomId}/voice-sessions", {
          params: { path: { roomId } },
          body: { purpose: "hardware_control" },
        }),
      );
    },
    [runtime.client],
  );

  return { ensureTarget, resolveVoiceSession };
}

/** Switches the recording target to another Agent direct Room. */
export function useVoiceTargetSelection(
  state: VoiceControlState,
  runtime: TeamHubRuntime,
  tenantId: string,
  disable: () => Promise<void>,
) {
  const {
    refs,
    setCapture,
    setListenerError,
    setPartialTranscript,
    setTargetAgentName,
    setTargetRoomId,
    setTranscriptItems,
    setVoiceSessionId,
  } = state;

  return useCallback(
    (roomId: string) => {
      if (refs.targetChangeRef.current)
        return Promise.reject(
          new Error("Switching recording target. Please wait"),
        );
      const operation = (async () => {
        if (refs.targetRef.current?.roomId === roomId) return;
        if (
          isActiveCapture(refs.captureRef.current) ||
          refs.startPromiseRef.current ||
          refs.enablePromiseRef.current
        )
          throw new Error(
            "Stop the current recording before switching targets",
          );
        const room = await teamHubData(
          runtime.client.api.GET("/v0/rooms/{roomId}", {
            params: { path: { roomId } },
          }),
        );
        if (room.kind !== "direct" || room.direct_peer?.kind !== "agent")
          throw new Error("Start recording in the Agent direct chat");
        // Recheck after the authorization read: a recording may have started meanwhile.
        if (
          isActiveCapture(refs.captureRef.current) ||
          refs.startPromiseRef.current ||
          refs.enablePromiseRef.current
        )
          throw new Error(
            "Stop the current recording before switching targets",
          );
        await disable();
        const session = refs.voiceSessionRef.current;
        if (session)
          await teamHubData(
            runtime.client.api.DELETE("/v0/voice-sessions/{voiceSessionId}", {
              params: { path: { voiceSessionId: session.id } },
            }),
          );
        refs.voiceSessionGenerationRef.current += 1;
        refs.voiceSessionRef.current = undefined;
        setVoiceSessionId(undefined);
        refs.targetRef.current = {
          roomId,
          agentId: room.direct_peer.id,
          agentName: room.direct_peer.display_name,
        };
        writeSelectedVoiceRoom(tenantId, roomId);
        setTargetRoomId(roomId);
        setTargetAgentName(room.direct_peer.display_name);
        setCapture(undefined);
        setTranscriptItems([]);
        setPartialTranscript(undefined);
        setListenerError(undefined);
      })();
      refs.targetChangeRef.current = operation;
      const clear = () => {
        if (refs.targetChangeRef.current === operation)
          refs.targetChangeRef.current = undefined;
      };
      void operation.then(clear, clear);
      return operation;
    },
    [
      disable,
      refs,
      runtime.client,
      setCapture,
      setListenerError,
      setPartialTranscript,
      setTargetAgentName,
      setTargetRoomId,
      setTranscriptItems,
      setVoiceSessionId,
      tenantId,
    ],
  );
}
