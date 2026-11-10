export interface DrainableDocumentRuntime {
  beginDrain(signal: AbortSignal): void;
  destroy(): Promise<void>;
  httpServer: { closeAllConnections(): void };
}

export async function drainDocumentRuntime(options: {
  runtime: DrainableDocumentRuntime;
  timeoutMs: number;
  reportError?: (message: string) => void;
}): Promise<0 | 1> {
  const drainController = new AbortController();
  options.runtime.beginDrain(drainController.signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error("Document Runtime drain deadline expired");
      drainController.abort(error);
      reject(error);
    }, options.timeoutMs);
    timeout.unref();
  });
  try {
    await Promise.race([options.runtime.destroy(), deadline]);
    return 0;
  } catch (error) {
    options.reportError?.(
      error instanceof Error ? error.message : "Document Runtime drain failed",
    );
    options.runtime.httpServer.closeAllConnections();
    return 1;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
