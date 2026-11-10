import { useEffect, useLayoutEffect, useRef, useState } from "react";

type ConnectionStatus = "online" | "offline";
export type ComputerDisplayStatus = ConnectionStatus | "reconnecting";
const stabilityWindowMs = 15_000;

export function useComputerConnectionStatus(
  computerId: string,
  status: ConnectionStatus,
): ComputerDisplayStatus {
  const observation = useRef({ computerId, status, since: Date.now() });
  const [display, setDisplay] = useState<ComputerDisplayStatus>(status);

  useLayoutEffect(() => {
    if (observation.current.computerId !== computerId) {
      observation.current = { computerId, status, since: Date.now() };
      setDisplay(status);
    } else if (observation.current.status !== status) {
      observation.current = { computerId, status, since: Date.now() };
      setDisplay("reconnecting");
    }
  }, [computerId, status]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() - observation.current.since >= stabilityWindowMs) {
        setDisplay(observation.current.status);
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [computerId]);

  return display;
}
