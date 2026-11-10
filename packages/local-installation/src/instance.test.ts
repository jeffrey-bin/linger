import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { parseEnv } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  type Instance,
  initializeInstance,
  loadInstance,
  withInstanceLock,
  writeModelConfig,
} from "./instance.js";
const homes: string[] = [];
async function home() {
  const value = await mkdtemp(path.join(tmpdir(), "linger-instance-"));
  homes.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});
it("persists stable private settings and credentials across repeated initialization", async () => {
  const root = await home();
  const first = await initializeInstance({ name: "default", home: root });
  const secrets = await readFile(path.join(first.root, "services.env"), "utf8");
  const second = await initializeInstance({ name: "default", home: root });
  expect(second).toEqual(first);
  expect(await loadInstance({ name: "default", home: root })).toEqual(first);
  expect(await readFile(path.join(first.root, "services.env"), "utf8")).toBe(
    secrets,
  );
  expect(first.origin).toBe(`http://localhost:${first.port}`);
  expect(
    (await stat(path.join(first.root, "instance.json"))).mode & 0o777,
  ).toBe(0o600);
  expect((await stat(first.root)).mode & 0o777).toBe(0o700);
});
// Without this key TeamHub cannot save a Composio key from the Apps page.
it("gives every instance its own TeamHub secret encryption key", async () => {
  const root = await home();
  const one = await initializeInstance({ name: "one", home: root });
  const two = await initializeInstance({ name: "two", home: root });
  const key = async (instance: Instance) =>
    parseEnv(await readFile(path.join(instance.root, "services.env"), "utf8"))
      .TEAMHUB_SECRET_ENCRYPTION_KEY;
  const first = await key(one);
  expect(Buffer.from(first!, "base64")).toHaveLength(32);
  expect(Buffer.from(first!, "base64").toString("base64")).toBe(first);
  expect(await key(two)).not.toBe(first);
});
// Instances installed before the key existed get one on their next install or start.
it("adds a missing TeamHub secret encryption key once and keeps every other credential", async () => {
  const root = await home();
  const instance = await initializeInstance({ name: "older", home: root });
  const file = path.join(instance.root, "services.env");
  const older = (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => !line.startsWith("TEAMHUB_SECRET_ENCRYPTION_KEY="))
    .join("\n");
  await writeFile(file, older);
  await initializeInstance({ name: "older", home: root });
  const upgraded = await readFile(file, "utf8");
  expect(upgraded.startsWith(older)).toBe(true);
  const key = parseEnv(upgraded).TEAMHUB_SECRET_ENCRYPTION_KEY;
  expect(Buffer.from(key!, "base64")).toHaveLength(32);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await initializeInstance({ name: "older", home: root });
  expect(await readFile(file, "utf8")).toBe(upgraded);
});
it("rejects path traversal names and invalid ports", async () => {
  const root = await home();
  await expect(
    initializeInstance({ name: "../evil", home: root }),
  ).rejects.toThrow(/name/i);
  await expect(
    initializeInstance({ name: "ok", home: root, port: 70000 }),
  ).rejects.toThrow(/port/i);
});
it("rejects an explicitly occupied port without killing its owner", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  try {
    await expect(
      initializeInstance({
        name: "busy",
        home: await home(),
        port: address.port,
      }),
    ).rejects.toThrow(/port/i);
  } finally {
    server.close();
  }
});
it("serializes concurrent initialization and refuses active operation locks", async () => {
  const root = await home();
  const [one, two] = await Promise.all([
    initializeInstance({ name: "shared", home: root }),
    initializeInstance({ name: "shared", home: root }),
  ]);
  expect(one).toEqual(two);
  await withInstanceLock(one, async () => {
    await expect(withInstanceLock(two, async () => {})).rejects.toThrow(
      /busy/i,
    );
  });
  await expect(withInstanceLock(one, async () => 42)).resolves.toBe(42);
});
it("keeps gateway keys in a separate private file and validates provider URLs", async () => {
  const instance = await initializeInstance({
    name: "model",
    home: await home(),
  });
  await writeModelConfig(instance, {
    baseUrl: "https://models.example.test/v1",
    apiKey: "super-private-key",
    model: "local-chat-model",
  });
  const descriptor = await readFile(
    path.join(instance.root, "instance.json"),
    "utf8",
  );
  expect(descriptor).not.toContain("super-private-key");
  const saved = await loadInstance({
    name: "model",
    home: path.dirname(path.dirname(instance.root)),
  });
  expect(saved?.model?.baseUrl).toBe("https://models.example.test/v1");
  expect(await readFile(instance.model!.keyFile, "utf8")).toBe(
    "super-private-key",
  );
  expect((await stat(instance.model!.keyFile)).mode & 0o777).toBe(0o600);
  await expect(
    writeModelConfig(instance, {
      baseUrl: "https://user:secret@models.test",
      apiKey: "secret",
      model: "local-chat-model",
    }),
  ).rejects.toThrow(/URL/i);
});
it("assigns distinct stable ports to two concurrent instances", async () => {
  const root = await home();
  const [one, two] = await Promise.all([
    initializeInstance({ name: "first", home: root }),
    initializeInstance({ name: "second", home: root }),
  ]);
  expect(one.port).not.toBe(two.port);
});
it("does not assign another stopped instance explicit port", async () => {
  const root = await home();
  const first = await initializeInstance({ name: "first", home: root });
  await expect(
    initializeInstance({ name: "second", home: root, port: first.port }),
  ).rejects.toThrow(/port/i);
});
it("isolates the Compose project when two homes use the same instance name", async () => {
  const firstHome = await mkdtemp(path.join(tmpdir(), "linger-first-"));
  const secondHome = await mkdtemp(path.join(tmpdir(), "linger-second-"));
  homes.push(firstHome, secondHome);
  const first = await initializeInstance({ name: "default", home: firstHome });
  const second = await initializeInstance({
    name: "default",
    home: secondHome,
  });
  expect(first.project).not.toBe(second.project);
  expect(
    (await initializeInstance({ name: "default", home: firstHome })).project,
  ).toBe(first.project);
});
it("persists the initial Computer display name across retries", async () => {
  const root = await home();
  const first = await initializeInstance({
    name: "computer-name",
    home: root,
    computerName: "My work computer",
  });
  expect(first.computerName).toBe("My work computer");
  const second = await initializeInstance({
    name: "computer-name",
    home: root,
    computerName: "Retry keeps the name",
  });
  expect(second.computerName).toBe("My work computer");
});
