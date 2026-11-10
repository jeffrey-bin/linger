// Realtime delivery follows the foreground tab. Microphone publishing keeps
// its own non-stealing lease until that tab explicitly releases the device.
export async function tryAcquireVoicePublisherLease(
  tenantId: string,
  locks = globalThis.navigator?.locks,
): Promise<(() => void) | undefined> {
  if (!locks) return () => undefined;
  return new Promise((resolve, reject) => {
    void locks
      .request(
        `linger:voice-publisher:${tenantId}`,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            resolve(undefined);
            return;
          }
          await new Promise<void>((release) => resolve(release));
        },
      )
      .catch(reject);
  });
}
