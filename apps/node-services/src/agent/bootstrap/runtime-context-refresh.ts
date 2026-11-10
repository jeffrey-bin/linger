/** Wake hints coalesce; persisted Runtime State remains the recovery authority. */
export const createRuntimeContextRefresh = (refresh: () => Promise<void>) => {
  let closed = false;
  let pending = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = 1000;

  const start = () => {
    if (closed || running || timer || !pending) return;
    pending = false;
    running = refresh()
      .then(() => {
        retryMs = 1000;
      })
      .catch(() => {
        // The caller logs failures. Retry even if no later publication arrives.
        pending = true;
        if (!closed) {
          timer = setTimeout(() => {
            timer = undefined;
            start();
          }, retryMs);
          timer.unref();
          retryMs = Math.min(retryMs * 2, 30_000);
        }
      })
      .finally(() => {
        running = undefined;
        start();
      });
  };
  return {
    request(): void {
      if (closed) return;
      pending = true;
      start();
    },
    async close(): Promise<void> {
      closed = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
};
