import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { afterEach, expect, test } from "vitest";
import { loadInstance } from "./instance.js";
import { updateUserKeys } from "./user-environment.js";
import { readLiveKitSettings } from "./native-livekit.js";
import {
  checkNativeSourceEnvironment,
  nativeSourceInstanceName,
  prepareNativeConfiguration,
} from "./native-source.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "native-source-"));
  roots.push(home);
  const repo = path.join(home, "repo");
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "linger" }),
  );
  await writeFile(path.join(repo, "scripts/source-native.mjs"), "export {};\n");
  return { home, repo };
}
test("native checkout identities are stable", async () => {
  const f = await fixture();
  expect(await nativeSourceInstanceName(f.repo)).toMatch(
    /^native-[a-f0-9]{12}$/,
  );
  const first = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-test",
  });
  expect(first.instance.mode).toBe("source-native");
  expect(
    (await loadInstance({ home: f.home, name: "native-test" }))?.mode,
  ).toBe("source-native");
  expect(first.env.TEAMHUB_HTTP_ADDRESS).toBe(
    `127.0.0.1:${first.instance.source!.ports.teamhub}`,
  );
  expect(first.env.TEAMHUB_DATABASE_URL).toContain(
    `:${first.instance.source!.ports.postgres}/simplexai`,
  );
  const text = await readFile(
    path.join(first.instance.root, "native.env"),
    "utf8",
  );
  const second = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-test",
  });
  expect(second.instance).toEqual(first.instance);
  expect(
    await readFile(path.join(first.instance.root, "native.env"), "utf8"),
  ).toBe(text);
});
test("native environment checks do not require or report Docker", async () => {
  const f = await fixture();
  const report = await checkNativeSourceEnvironment({
    ...f,
    signal: new AbortController().signal,
  });
  expect(report.releaseAvailable).toBe(true);
  expect(report.checks.some((row) => row.id === "source-native")).toBe(true);
  expect(report.checks.some((row) => /docker|compose/i.test(row.id))).toBe(
    false,
  );
});
test("native env files omit launcher-only keys while child env retains its file", async () => {
  const f = await fixture();
  const native = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-env",
  });
  const nativeFile = path.join(native.instance.root, "native.env");
  const persisted = parseEnv(await readFile(nativeFile, "utf8"));
  const omitted = [
    "WEB_HTTP_PORT",
    "TEAMHUB_HTTP_PORT",
    "DOCUMENT_RUNTIME_HTTP_PORT",
    "POSTGRES_PORT",
    "HOST",
    "LOCAL_ENV_FILE",
  ];
  for (const key of omitted) expect(persisted).not.toHaveProperty(key);
  expect(native.env.LOCAL_ENV_FILE).toBe(nativeFile);
  expect(persisted.TEAMHUB_HTTP_ADDRESS).toBe(native.env.TEAMHUB_HTTP_ADDRESS);
  expect(persisted.NODE_SERVICES_HTTP_PORT).toBe(
    native.env.NODE_SERVICES_HTTP_PORT,
  );
  // Every process listens on its own allocated port, never the defaults.
  const { ports } = native.instance.source!;
  expect(persisted).toMatchObject({
    NODE_SERVICES_HTTP_ADDRESS: `127.0.0.1:${ports.nodeServices}`,
    DOCUMENT_RUNTIME_HTTP_ADDRESS: `127.0.0.1:${ports.document}`,
    TEAMHUB_NODE_SERVICES_URL: `http://127.0.0.1:${ports.nodeServices}`,
    TEAMHUB_DOCUMENT_RUNTIME_URL: `http://127.0.0.1:${ports.document}`,
  });
});

test("keys saved from the setup page and LiveKit reach the Native services", async () => {
  const f = await fixture();
  const keys = { SONIOX_API_KEY: "soniox-1", XAI_API_KEY: "xai-1" };
  const root = (name: string) => path.join(f.home, "instances", name);
  await updateUserKeys(root("native-keys"), keys);
  // Native turns voice off at start when it has no voice tools.
  const native = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-keys",
  });
  expect(native.env).toMatchObject(keys);
  // Native runs its own LiveKit on loopback with keys made for the instance.
  const liveKit = await readLiveKitSettings(native.instance.root);
  expect(liveKit).toBeDefined();
  expect(native.env).toMatchObject({
    LIVEKIT_URL: `ws://127.0.0.1:${liveKit!.httpPort}`,
    LIVEKIT_API_URL: `http://127.0.0.1:${liveKit!.httpPort}`,
    LIVEKIT_API_KEY: liveKit!.apiKey,
    LIVEKIT_API_SECRET: liveKit!.apiSecret,
  });
  expect(liveKit!.apiSecret.length).toBeGreaterThanOrEqual(32);
  const ports = Object.values(native.instance.source!.ports);
  expect(ports).not.toContain(liveKit!.httpPort);
  // The ports and keys stay across starts.
  const repeated = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-keys",
  });
  expect(await readLiveKitSettings(repeated.instance.root)).toEqual(liveKit);
  // A cleared key is gone from the next start's environment.
  await updateUserKeys(root("native-keys"), { SONIOX_API_KEY: "" });
  const again = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-keys",
  });
  expect(again.env).not.toHaveProperty("SONIOX_API_KEY");
  expect(again.env.XAI_API_KEY).toBe("xai-1");
});
test("an owned native instance follows a new checkout and keeps its data", async () => {
  const f = await fixture();
  const first = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "desktop",
  });
  await writeFile(path.join(first.instance.root, "kept"), "data");
  const next = path.join(f.home, "next");
  await mkdir(path.join(next, "scripts"), { recursive: true });
  for (const file of ["package.json", "scripts/source-native.mjs"])
    await writeFile(
      path.join(next, file),
      await readFile(path.join(f.repo, file)),
    );
  await expect(
    prepareNativeConfiguration(next, { home: f.home, name: "desktop" }),
  ).rejects.toThrow(/bound/);
  const moved = await prepareNativeConfiguration(next, {
    home: f.home,
    name: "desktop",
    rebindSource: true,
  });
  expect(moved.instance.releaseDir).toBe(next);
  expect(moved.instance.source!.repo).toBe(next);
  expect(moved.instance.source!.ports).toEqual(first.instance.source!.ports);
  expect(moved.instance.port).toBe(first.instance.port);
  expect(await readFile(path.join(first.instance.root, "kept"), "utf8")).toBe(
    "data",
  );
  expect(
    (await loadInstance({ home: f.home, name: "desktop" }))?.releaseDir,
  ).toBe(next);
});
