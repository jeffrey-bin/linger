const recoveredBuildStorageKey = "linger.web.vite-preload-recovery.v1";

interface VitePreloadRecoveryOptions {
  buildId: string;
  eventTarget?: EventTarget;
  reload?: () => void;
  storage?: Storage;
}

export function installVitePreloadRecovery({
  buildId,
  eventTarget = globalThis.window,
  reload = () => globalThis.location.reload(),
  storage = globalThis.sessionStorage,
}: VitePreloadRecoveryOptions) {
  const handlePreloadError = (event: Event) => {
    try {
      if (storage.getItem(recoveredBuildStorageKey) === buildId) {
        return;
      }
      storage.setItem(recoveredBuildStorageKey, buildId);
    } catch {
      return;
    }

    event.preventDefault();
    reload();
  };

  eventTarget.addEventListener("vite:preloadError", handlePreloadError);
  return () =>
    eventTarget.removeEventListener("vite:preloadError", handlePreloadError);
}
