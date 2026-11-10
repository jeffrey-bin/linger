import { afterEach, expect, it, vi } from "vitest";
import {
  configuredNpmRegistry,
  npmRegistryEnvironment,
  npmTarballUrl,
  rankNpmRegistries,
} from "./npm-registry.js";

afterEach(() => vi.unstubAllEnvs());

const slow = (bytes: number) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
      },
    }),
  );

it("puts the registry that delivers more of the probe first", async () => {
  const requested: string[] = [];
  const order = await rankNpmRegistries(
    new AbortController().signal,
    async (url, init) => {
      requested.push((url as URL | string).toString());
      expect(init?.redirect).toBe("error");
      return (url as URL | string).toString().includes("npmmirror")
        ? slow(4096)
        : slow(16);
    },
    50,
  );
  expect(order).toEqual([
    "https://registry.npmmirror.com/",
    "https://registry.npmjs.org/",
  ]);
  expect(requested.sort()).toEqual([
    "https://cdn.npmmirror.com/packages/pnpm/11.7.0/pnpm-11.7.0.tgz",
    "https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz",
  ]);
});

it("keeps the public registry first when nothing answers", async () => {
  expect(
    await rankNpmRegistries(
      new AbortController().signal,
      async () => {
        throw new TypeError("fetch failed");
      },
      50,
    ),
  ).toEqual(["https://registry.npmjs.org/", "https://registry.npmmirror.com/"]);
});

it("respects a configured registry and points native downloads at the mirror", () => {
  for (const name of [
    "pnpm_config_registry",
    "PNPM_CONFIG_REGISTRY",
    "npm_config_registry",
    "NPM_CONFIG_REGISTRY",
  ])
    vi.stubEnv(name, "");
  expect(configuredNpmRegistry()).toBeUndefined();
  vi.stubEnv("npm_config_registry", "https://r.test/");
  expect(configuredNpmRegistry()).toBe("https://r.test/");
  expect(npmTarballUrl("https://registry.npmjs.org/", "npm", "1.0.0")).toBe(
    "https://registry.npmjs.org/npm/-/npm-1.0.0.tgz",
  );
  expect(npmRegistryEnvironment("https://registry.npmjs.org/")).toEqual({
    pnpm_config_registry: "https://registry.npmjs.org/",
  });
  expect(
    npmRegistryEnvironment("https://registry.npmmirror.com/"),
  ).toMatchObject({
    pnpm_config_registry: "https://registry.npmmirror.com/",
    npm_config_better_sqlite3_binary_host_mirror:
      "https://registry.npmmirror.com/-/binary/better-sqlite3",
  });
});
