import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  collectDiagnostics,
  diagnosticsEntry,
  excludedFromDiagnostics,
  redactDiagnostics,
} from "./diagnostics.js";
import { tempDirectory } from "./test-support.js";

// Reads every entry of a zip through its central directory.
const unzip = (file: string): Map<string, string> => {
  const zip = readFileSync(file);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    entries.set(
      name,
      (method === 8 ? inflateRawSync(data) : data).toString("utf8"),
    );
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe("excludedFromDiagnostics", () => {
  it.each([
    "C:\\Users\\me\\.linger\\instances\\desktop\\computer\\Gateway.JSON",
    "C:\\Users\\me\\.linger\\instances\\desktop\\caller.key",
    "C:\\Users\\me\\.linger\\instances\\desktop\\control.key",
    "C:\\Users\\me\\.linger\\instances\\desktop\\compose.env",
    "C:\\Users\\me\\.linger\\instances\\desktop\\launch.html",
    "C:\\Users\\me\\.linger\\installer\\jobs\\job_1.input.json",
    "C:\\Users\\me\\AppData\\Roaming\\Linger\\computer\\credential.json",
    "C:\\Users\\me\\AppData\\Roaming\\Linger\\Network\\Cookies",
    "/home/me/.linger/instances/desktop/.env.local",
    "/home/me/.linger/instances/desktop/postgres-password",
  ])("leaves out %s", (file) => {
    expect(excludedFromDiagnostics(file)).toBe(true);
  });

  it.each([
    "C:\\Users\\me\\.linger\\installer\\jobs\\job_1.json",
    "C:\\Users\\me\\AppData\\Roaming\\Linger\\logs\\computer-daemon.log",
    "/home/me/.linger/instances/desktop/instance.json",
  ])("keeps %s", (file) => {
    expect(excludedFromDiagnostics(file)).toBe(false);
  });
});

describe("diagnosticsEntry", () => {
  it("names Windows files with forward slashes below the prefix", () => {
    expect(
      diagnosticsEntry(
        "linger-home",
        "C:\\Users\\me\\.linger",
        "C:\\Users\\me\\.linger\\installer\\jobs\\job_1.json",
        path.win32,
      ),
    ).toBe("linger-home/installer/jobs/job_1.json");
  });
});

describe("redactDiagnostics", () => {
  it("hides tokens, passwords and bearer credentials", () => {
    const text = redactDiagnostics(
      [
        '{"accessToken": "abc123", "db_password": "hunter2", "name": "kept"}',
        "authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      ].join("\n"),
    );
    expect(text).not.toMatch(/abc123|hunter2|eyJhbGciOiJIUzI1NiJ9/);
    expect(text).toContain('"name": "kept"');
  });
});

describe("collectDiagnostics", () => {
  it("bundles logs and job state without credentials", async () => {
    const root = tempDirectory();
    const userData = path.join(root, "userData");
    const home = path.join(root, "home");
    const output = path.join(root, "out");
    mkdirSync(output);
    write(
      path.join(userData, "logs", "main.log"),
      'local_server.install_failed {"token":"t-secret"}\n',
    );
    write(
      path.join(userData, "logs", "computer-daemon.log"),
      "runtime.diagnostic type=codex status=authentication_required\n",
    );
    write(path.join(userData, "computer", "credential.json"), "{}");
    write(path.join(userData, "Cookies"), "cookie");
    write(
      path.join(home, "installer", "jobs", "job_1.json"),
      '{"state":"failed"}',
    );
    write(
      path.join(home, "installer", "jobs", "job_1.input.json"),
      '{"apiKey":"sk-1"}',
    );
    write(
      path.join(home, "instances", "desktop", "instance.json"),
      JSON.stringify({ mode: "source-native" }),
    );
    write(path.join(home, "instances", "desktop", "caller.key"), "key");
    write(path.join(home, "instances", "desktop", "services.env"), "A=1");
    write(
      path.join(home, "instances", "desktop", "native", "logs", "teamhub.log"),
      "another_me.create_failed\n",
    );
    write(path.join(home, "instances", "desktop", "data", "db.json"), "{}");

    const file = await collectDiagnostics({
      userData,
      homes: [home, home],
      output,
      summary: { version: "0.16.27" },
      now: new Date("2026-11-06T07:08:09Z"),
    });

    expect(path.basename(file)).toBe("linger-diagnostics-20261106-070809.zip");
    if (process.platform !== "win32")
      expect(statSync(file).mode & 0o777).toBe(0o600);
    const entries = unzip(file);
    expect([...entries.keys()].sort()).toEqual([
      "desktop/logs/computer-daemon.log",
      "desktop/logs/main.log",
      "linger-home/installer/jobs/job_1.json",
      "linger-home/instances/desktop/instance.json",
      "linger-home/instances/desktop/native/logs/teamhub.log",
      "summary.json",
    ]);
    expect(entries.get("desktop/logs/main.log")).not.toContain("t-secret");
    expect(JSON.parse(entries.get("summary.json")!)).toMatchObject({
      version: "0.16.27",
      homes: [path.resolve(home)],
    });
  });

  it("hides saved provider keys wherever a log printed them", async () => {
    const root = tempDirectory();
    const home = path.join(root, "home");
    const output = path.join(root, "out");
    mkdirSync(output);
    write(
      path.join(home, "instances", "desktop", "user.env"),
      "COMPOSIO_API_KEY=composio-789\nSONIOX_API_KEY=soniox-123\nXAI_API_KEY=xai-456\n",
    );
    write(
      path.join(home, "instances", "desktop", "instance.json"),
      JSON.stringify({ mode: "source-native" }),
    );
    write(
      path.join(home, "instances", "desktop", "native", "logs", "voice.log"),
      "connecting with soniox-123\nlive session key xai-456 rejected\n",
    );
    const entries = unzip(
      await collectDiagnostics({
        userData: path.join(root, "userData"),
        homes: [home],
        output,
        summary: {},
      }),
    );
    expect(entries.has("linger-home/instances/desktop/user.env")).toBe(false);
    const text = [...entries.values()].join("\n");
    expect(text).not.toContain("soniox-123");
    expect(text).not.toContain("xai-456");
    expect(text).not.toContain("composio-789");
    expect(
      entries.get("linger-home/instances/desktop/native/logs/voice.log"),
    ).toContain("live session key [REDACTED] rejected\n");
  });
});
