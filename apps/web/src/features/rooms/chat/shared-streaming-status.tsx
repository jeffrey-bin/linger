import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";

type StatusSurface = "chat" | "thread";
type StatusTargets = Record<StatusSurface, HTMLDivElement | null>;

const StreamingStatusContext = createContext<{
  targets: StatusTargets;
  refs: Record<StatusSurface, (node: HTMLDivElement | null) => void>;
} | null>(null);

export function SharedStreamingStatusProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [chat, setChat] = useState<HTMLDivElement | null>(null);
  const [thread, setThread] = useState<HTMLDivElement | null>(null);
  const value = useMemo(
    () => ({
      targets: { chat, thread },
      refs: { chat: setChat, thread: setThread },
    }),
    [chat, thread],
  );
  return (
    <StreamingStatusContext value={value}>{children}</StreamingStatusContext>
  );
}

/**
 * Mirrors each source's status in both composers; subscriptions, Stop and
 * navigation stay with the source. A Run shows its status in one Room or
 * Thread only, so the two sources never show the same Run.
 */
export function SharedStreamingStatus({
  children,
  surface,
}: {
  children: ReactNode;
  surface: StatusSurface;
}) {
  const shared = useContext(StreamingStatusContext);
  if (!shared) return children;
  return (
    <>
      <div ref={shared.refs[surface]} data-streaming-surface={surface} />
      {Object.entries(shared.targets).map(([key, target]) =>
        target ? createPortal(children, target, `${surface}:${key}`) : null,
      )}
    </>
  );
}
