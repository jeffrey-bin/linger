import { TeamHubTransportError } from "@/features/teamhub/teamhub-error";

export function abortVoiceRequest(
  controller: AbortController | undefined,
  reason: string,
) {
  if (!controller || controller.signal.aborted) return;
  controller.abort(new DOMException(reason, "AbortError"));
}

/** Owns only voice control requests; document and attachment transfers keep their own budgets. */
export class VoiceRequestScope {
  private readonly controllers = new Set<AbortController>();

  async run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    parent?: AbortSignal,
  ): Promise<T> {
    parent?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => {
      if (controller.signal.aborted) return;
      controller.abort(
        parent?.reason ??
          new DOMException("Voice request cancelled", "AbortError"),
      );
    };
    parent?.addEventListener("abort", abort, { once: true });
    this.controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortVoiceRequest(controller, "Voice request timed out");
    }, 5_000);
    try {
      return await operation(controller.signal);
    } catch (cause) {
      if (timedOut && !parent?.aborted)
        throw new TeamHubTransportError("Voice request timed out");
      if (cause instanceof TypeError && !controller.signal.aborted)
        throw new TeamHubTransportError("Voice response could not be read");
      throw cause;
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
      this.controllers.delete(controller);
    }
  }

  cancel() {
    for (const controller of this.controllers) {
      abortVoiceRequest(controller, "Voice request cancelled");
    }
  }
}

export function waitForVoiceDelay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
  });
}
