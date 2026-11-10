const CHANNEL_NAME = "linger.local-computer-enrollment.v1";

export interface LocalComputerEnrollmentCreated {
  readonly computerId: string;
  readonly tenantId: string;
}

const listeners = new Set<(event: LocalComputerEnrollmentCreated) => void>();

export function publishLocalComputerEnrollment(
  event: LocalComputerEnrollmentCreated,
): void {
  for (const listener of listeners) listener(event);
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(event);
    channel.close();
  }
}

export function subscribeLocalComputerEnrollment(
  listener: (event: LocalComputerEnrollmentCreated) => void,
): () => void {
  listeners.add(listener);
  const channel =
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel(CHANNEL_NAME);
  const receive = (message: MessageEvent<unknown>): void => {
    if (isEnrollmentEvent(message.data)) listener(message.data);
  };
  channel?.addEventListener("message", receive);
  return () => {
    listeners.delete(listener);
    channel?.removeEventListener("message", receive);
    channel?.close();
  };
}

const isEnrollmentEvent = (
  value: unknown,
): value is LocalComputerEnrollmentCreated =>
  typeof value === "object" &&
  value !== null &&
  "computerId" in value &&
  typeof value.computerId === "string" &&
  value.computerId.length > 0 &&
  "tenantId" in value &&
  typeof value.tenantId === "string" &&
  value.tenantId.length > 0;
