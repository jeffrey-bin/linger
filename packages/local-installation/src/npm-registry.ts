export const npmRegistry = "https://registry.npmjs.org/";
export const npmMirrorRegistry = "https://registry.npmmirror.com/";

/** Where each registry serves a package tarball without a redirect. */
export function npmTarballUrl(registry: string, name: string, version: string) {
  return registry === npmMirrorRegistry
    ? `https://cdn.npmmirror.com/packages/${name}/${version}/${name}-${version}.tgz`
    : `${registry}${name}/-/${name}-${version}.tgz`;
}

/**
 * Package installs read the registry from this environment. The mirror also
 * serves the prebuilt native modules and Node headers that install scripts
 * would otherwise fetch from GitHub and nodejs.org.
 */
export function npmRegistryEnvironment(registry: string): NodeJS.ProcessEnv {
  return registry === npmMirrorRegistry
    ? {
        pnpm_config_registry: registry,
        npm_config_better_sqlite3_binary_host_mirror:
          "https://registry.npmmirror.com/-/binary/better-sqlite3",
        npm_config_disturl: "https://npmmirror.com/mirrors/node",
      }
    : { pnpm_config_registry: registry };
}

/** A registry the person configured is the only one used. */
export function configuredNpmRegistry() {
  return (
    process.env.pnpm_config_registry ||
    process.env.PNPM_CONFIG_REGISTRY ||
    process.env.npm_config_registry ||
    process.env.NPM_CONFIG_REGISTRY ||
    undefined
  );
}

/**
 * Orders the public registry and its China mirror by how many bytes of the
 * same tarball each delivers within the probe window. A registry that cannot
 * be reached at all goes last; the install still falls back to it.
 */
export async function rankNpmRegistries(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  probeMs = 4_000,
): Promise<string[]> {
  const registries = [npmRegistry, npmMirrorRegistry];
  const window = AbortSignal.any([signal, AbortSignal.timeout(probeMs)]);
  // A body that ignores the signal still stops counting when the window ends.
  const closed = new Promise<never>((_resolve, reject) =>
    window.addEventListener("abort", () => reject(new Error())),
  );
  closed.catch(() => {});
  const received = await Promise.all(
    registries.map(async (registry) => {
      let bytes = 0;
      try {
        const response = await fetcher(
          npmTarballUrl(registry, "pnpm", "11.7.0"),
          { redirect: "error", signal: window },
        );
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          return -1;
        }
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await Promise.race([reader.read(), closed]);
            if (done) break;
            bytes += value.byteLength;
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } catch {
        // The probe window ending mid-body still measured progress.
      }
      return bytes;
    }),
  );
  signal.throwIfAborted();
  return registries
    .map((registry, index) => ({ registry, bytes: received[index]! }))
    .sort((left, right) => right.bytes - left.bytes)
    .map((item) => item.registry);
}
