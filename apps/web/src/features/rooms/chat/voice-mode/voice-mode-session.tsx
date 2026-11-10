import { QueryClientContext } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { useOptionalTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActorRef,
  TeamHubVoiceLiveTurnMarker,
} from "@/features/teamhub/teamhub-types";
import { useOptionalVoiceControl } from "@/features/rooms/voice-control/voice-control-context";
import type { VoiceLiveLine } from "./live/voice-live-arbiter";
import type { VoiceModeState } from "./voice-mode-controller";
import type { VoiceModePresentation } from "./voice-mode-presentation";
import type { VoiceTurnPrefix } from "./voice-mode-room-sender";
import type { VoiceModeSessionEngine } from "./voice-mode-session-engine";

export interface VoiceModeSessionTarget {
  accountId: string;
  roomId: string;
  roomName: string;
  tenantId: string;
  recipient?: TeamHubActorRef;
}

/**
 * Sends one prepared turn once. A live turn the live model answers carries
 * its marker; anything else is an ordinary Message that wakes the Agent.
 */
export type VoiceModeTurnSend = (
  voiceLiveTurn?: TeamHubVoiceLiveTurnMarker,
) => Promise<void>;

/** What a mounted Room composer offers the session for its own turns. */
export interface VoiceModeRoomBinding {
  onChange: (presentation: VoiceModePresentation) => void;
  prepareSend: (text: string, eventId: string) => VoiceModeTurnSend;
}

/** Which Voice Mode the server allows for the current Human. */
export interface VoiceModeModes {
  dictation: boolean;
  live: boolean;
}

/** Present while the live model answers by voice. */
export interface VoiceModeLivePresentation {
  /** The reply's speaker is silenced; the microphone is unaffected. */
  soundOff: boolean;
  /** This call's exchanges in the order they were said. */
  transcript: readonly VoiceLiveLine[];
}

export interface VoiceModeSession {
  closing: boolean;
  entered: boolean;
  live?: VoiceModeLivePresentation;
  muted: boolean;
  prefix: VoiceTurnPrefix;
  sourceId: string;
  startedAt: string;
  state: VoiceModeState;
  target: VoiceModeSessionTarget;
}

interface VoiceModeSessionApi {
  session: VoiceModeSession | undefined;
  /** The live microphone level, kept out of `session` so it rerenders only meters. */
  level: VoiceModeLevelStore;
  bind: (roomId: string, binding: VoiceModeRoomBinding) => () => void;
  exit: () => void;
  retry: () => void;
  setMuted: (muted: boolean) => Promise<void>;
  setSoundOff: (soundOff: boolean) => void;
  /** Loads Voice Mode's code before the Human clicks, so starting is quick. */
  prepare: () => void;
  start: (
    target: VoiceModeSessionTarget,
    prefix: VoiceTurnPrefix,
    modes?: VoiceModeModes,
  ) => void;
}

interface VoiceModeLevelStore {
  get: () => number;
  subscribe: (listener: () => void) => () => void;
}

function createLevelStore() {
  let level = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => level,
    publish(next: number) {
      if (next === level) return;
      level = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const VoiceModeSessionContext = createContext<VoiceModeSessionApi | undefined>(
  undefined,
);

/**
 * Holds the one Voice Mode session above the Room routes, so dictation keeps
 * running while the Human moves between Rooms. Turns always go to the Room the
 * session started in. The session engine loads on the first start, keeping
 * this provider small in the app shell's initial bundle.
 */
export function VoiceModeSessionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const runtime = useOptionalTeamHubRuntime();
  const hardware = useOptionalVoiceControl();
  const queryClient = useContext(QueryClientContext);
  const deps = useRef({ hardware, queryClient, runtime });
  useLayoutEffect(() => {
    deps.current = { hardware, queryClient, runtime };
  });
  const [session, setSession] = useState<VoiceModeSession>();
  const bindings = useRef(new Map<string, VoiceModeRoomBinding>());
  const engine = useRef<VoiceModeSessionEngine>(undefined);
  const [levelStore] = useState(createLevelStore);
  useEffect(() => () => engine.current?.dispose(), []);
  const api = useMemo(() => {
    // One shared load, so quick repeated starts still create one engine.
    let loading: Promise<VoiceModeSessionEngine> | undefined;
    const load = () =>
      (loading ??= import("./voice-mode-session-engine").then(
        ({ createVoiceModeSessionEngine }) =>
          (engine.current = createVoiceModeSessionEngine({
            bindings: bindings.current,
            deps: () => ({
              ...deps.current,
              queryClient: deps.current.queryClient ?? undefined,
            }),
            publish: setSession,
            publishLevel: levelStore.publish,
          })),
      ));
    return {
      bind(roomId: string, binding: VoiceModeRoomBinding) {
        bindings.current.set(roomId, binding);
        engine.current?.resume(roomId, binding);
        return () => {
          if (bindings.current.get(roomId) === binding)
            bindings.current.delete(roomId);
        };
      },
      exit: () => engine.current?.exit(),
      retry: () => engine.current?.retry(),
      setMuted: async (muted: boolean) => engine.current?.setMuted(muted),
      setSoundOff: (soundOff: boolean) => engine.current?.setSoundOff(soundOff),
      prepare() {
        void load().catch(() => undefined);
        void import("livekit-client").catch(() => undefined);
      },
      start(
        target: VoiceModeSessionTarget,
        prefix: VoiceTurnPrefix,
        modes?: VoiceModeModes,
      ) {
        void load().then((loaded) => loaded.start(target, prefix, modes));
      },
      level: { get: levelStore.get, subscribe: levelStore.subscribe },
    };
  }, [levelStore]);
  const value = useMemo(() => ({ ...api, session }), [api, session]);
  return (
    <VoiceModeSessionContext.Provider value={value}>
      {children}
    </VoiceModeSessionContext.Provider>
  );
}

export function useOptionalVoiceModeSession() {
  return useContext(VoiceModeSessionContext);
}

const silentLevel: VoiceModeLevelStore = {
  get: () => 0,
  subscribe: () => () => undefined,
};

/** The live microphone level; only the components that draw it rerender. */
export function useVoiceModeLevel() {
  const store = useContext(VoiceModeSessionContext)?.level ?? silentLevel;
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
