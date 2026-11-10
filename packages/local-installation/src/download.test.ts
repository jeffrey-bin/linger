import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadVerified } from "./download.js";
const roots: string[] = [];
const fast = { attempts: 2, retryDelayMs: 0, idleTimeoutMs: 1_000 };
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
it("verifies streamed bytes before publishing a file and reports byte progress", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("trusted fixture");
  const events: number[] = [];
  const output = path.join(root, "kit.tgz");
  await downloadVerified(
    {
      url: "https://registry.npmjs.org/fixture.tgz",
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: 100,
      signal: new AbortController().signal,
      onProgress: (n) => events.push(n),
    },
    async () => new Response(bytes),
  );
  expect(await readFile(output)).toEqual(bytes);
  expect(events.at(-1)).toBe(bytes.length);
});
it("a bad checksum never publishes an executable archive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const output = path.join(root, "kit.tgz");
  await expect(
    downloadVerified(
      {
        url: "https://registry.npmjs.org/fixture.tgz",
        output,
        digest: "0".repeat(64),
        algorithm: "sha256",
        maxBytes: 100,
        signal: new AbortController().signal,
      },
      async () => new Response("wrong"),
    ),
  ).rejects.toThrow(/checksum/i);
  await expect(access(output)).rejects.toThrow();
});
it("rejects HTTP, credential-bearing URLs, and downloads over the size bound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const options = {
    output: path.join(root, "kit.tgz"),
    digest: "0".repeat(64),
    algorithm: "sha256" as const,
    maxBytes: 2,
    signal: new AbortController().signal,
  };
  for (const url of [
    "http://example.com/kit",
    "https://secret@example.com/kit",
    "https://example.com/kit?token=secret",
  ])
    await expect(downloadVerified({ ...options, url })).rejects.toThrow();
  await expect(
    downloadVerified(
      { ...options, url: "https://example.com/kit" },
      async () => new Response("too big"),
    ),
  ).rejects.toThrow(/size/i);
});

it("reports interrupted streams safely and keeps partial progress without publishing files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const events: number[] = [];
  const broken = () => {
    let pulls = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(Buffer.from("partial"));
        else
          controller.error(
            new TypeError("terminated", {
              cause: new Error("private transport details"),
            }),
          );
      },
    });
  };
  await expect(
    downloadVerified(
      {
        url: "https://example.com/kit",
        output: path.join(root, "kit.tgz"),
        algorithm: "sha256",
        digest: "0".repeat(64),
        maxBytes: 100,
        signal: new AbortController().signal,
        onProgress: (completed) => events.push(completed),
      },
      async () =>
        new Response(broken(), { headers: { "content-length": "100" } }),
      fast,
    ),
  ).rejects.toThrow(
    "Download of kit from example.com failed (interrupted). Check your network and retry.",
  );
  expect(events[0]).toBe(7);
  expect(await readdir(root)).toEqual([]);
});

it("replaces fetch transport details with safe actionable guidance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const error = await downloadVerified(
    {
      url: "https://example.com/private-kit",
      output: path.join(root, "kit.tgz"),
      algorithm: "sha256",
      digest: "0".repeat(64),
      maxBytes: 100,
      signal: new AbortController().signal,
    },
    async () => {
      throw new TypeError("failed https://example.com/private-kit", {
        cause: new Error("sensitive cause"),
      });
    },
    fast,
  ).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    "Download of private-kit from example.com failed (no connection). Check your network and retry.",
  );
  expect((error as Error).cause).toBeUndefined();
  expect(await readdir(root)).toEqual([]);
});

it.each(["fetch", "stream"])(
  "preserves explicit cancellation during %s",
  async (boundary) => {
    const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
    roots.push(root);
    const abort = new AbortController();
    const reason = new Error("Installation cancelled.");
    const fail = () => {
      abort.abort(reason);
      throw new TypeError("terminated");
    };
    await expect(
      downloadVerified(
        {
          url: "https://example.com/kit",
          output: path.join(root, "kit.tgz"),
          algorithm: "sha256",
          digest: "0".repeat(64),
          maxBytes: 100,
          signal: abort.signal,
        },
        async () => {
          if (boundary === "fetch") return fail();
          return new Response(
            new ReadableStream({ pull: fail }, { highWaterMark: 0 }),
          );
        },
      ),
    ).rejects.toBe(reason);
    expect(await readdir(root)).toEqual([]);
  },
);

it("preserves filesystem failures outside the transport boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("trusted fixture");
  await expect(
    downloadVerified(
      {
        url: "https://example.com/kit",
        output: path.join(root, "missing", "kit.tgz"),
        algorithm: "sha256",
        digest: createHash("sha256").update(bytes).digest("hex"),
        maxBytes: 100,
        signal: new AbortController().signal,
      },
      async () => new Response(bytes),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(root)).toEqual([]);
});

it("resumes an interrupted transfer with a range request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("resumable trusted fixture");
  const ranges: (string | null)[] = [];
  const output = path.join(root, "kit.tgz");
  await downloadVerified(
    {
      url: "https://example.com/kit.tgz",
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: 100,
      signal: new AbortController().signal,
    },
    async (_url, init) => {
      const range = new Headers(init?.headers).get("range");
      ranges.push(range);
      if (!range) {
        let pulls = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(bytes.subarray(0, 9));
              else controller.error(new TypeError("terminated"));
            },
          }),
        );
      }
      return new Response(bytes.subarray(9), {
        status: 206,
        headers: {
          "content-range": `bytes 9-${bytes.length - 1}/${bytes.length}`,
        },
      });
    },
    fast,
  );
  expect(ranges).toEqual([null, "bytes=9-"]);
  expect(await readFile(output)).toEqual(bytes);
});

it("continues a stalled transfer on the mirror before retrying the first host", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("resumable trusted fixture");
  const requests: string[] = [];
  const output = path.join(root, "kit.tgz");
  await downloadVerified(
    {
      url: "https://primary.example/kit.tgz",
      mirrors: ["https://mirror.example/kit.tgz"],
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: 100,
      signal: new AbortController().signal,
    },
    async (url, init) => {
      const range = new Headers(init?.headers).get("range");
      requests.push(`${new URL(url as URL).host} ${range}`);
      if (new URL(url as URL).host === "primary.example") {
        let pulls = 0;
        // Sends part of the file, then nothing.
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(bytes.subarray(0, 9));
              else return new Promise(() => {});
            },
          }),
        );
      }
      return new Response(bytes.subarray(9), {
        status: 206,
        headers: {
          "content-range": `bytes 9-${bytes.length - 1}/${bytes.length}`,
        },
      });
    },
    { ...fast, retryDelayMs: 60_000, idleTimeoutMs: 20 },
  );
  expect(requests).toEqual(["primary.example null", "mirror.example bytes=9-"]);
  expect(await readFile(output)).toEqual(bytes);
});

it("moves to a mirror when the first host cannot serve the file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("mirrored fixture");
  const hosts: string[] = [];
  const output = path.join(root, "kit.tgz");
  await downloadVerified(
    {
      url: "https://primary.example/kit.tgz",
      mirrors: ["https://mirror.example/kit.tgz"],
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: 100,
      signal: new AbortController().signal,
    },
    async (url) => {
      hosts.push(new URL(url as URL).host);
      return new URL(url as URL).host === "primary.example"
        ? new Response("missing", { status: 404 })
        : new Response(bytes);
    },
    fast,
  );
  expect(hosts).toEqual(["primary.example", "mirror.example"]);
  expect(await readFile(output)).toEqual(bytes);
});

it("restarts an attempt that stops receiving bytes and names every host on failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  let calls = 0;
  await expect(
    downloadVerified(
      {
        url: "https://primary.example/go.tar.gz",
        mirrors: ["https://mirror.example/go.tar.gz"],
        output: path.join(root, "go.tar.gz"),
        digest: "0".repeat(64),
        algorithm: "sha256",
        maxBytes: 100,
        signal: new AbortController().signal,
      },
      async () => {
        calls += 1;
        return new Response(
          new ReadableStream({ pull: () => new Promise(() => {}) }),
        );
      },
      { attempts: 2, retryDelayMs: 0, idleTimeoutMs: 20 },
    ),
  ).rejects.toThrow(
    "Download of go.tar.gz from primary.example and mirror.example failed (stalled). Check your network and retry.",
  );
  expect(calls).toBe(4);
  expect(await readdir(root)).toEqual([]);
});

it("keeps a resumable partial file for the next call", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("bundle bytes that arrive in two runs");
  const output = path.join(root, "bundle.tgz");
  const options = {
    url: "https://example.com/bundle.tgz",
    output,
    digest: createHash("sha256").update(bytes).digest("hex"),
    algorithm: "sha256" as const,
    maxBytes: 100,
    resumable: true,
  };
  await expect(
    downloadVerified(
      { ...options, signal: new AbortController().signal },
      async () => {
        let pulls = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(bytes.subarray(0, 10));
              else controller.error(new TypeError("terminated"));
            },
          }),
        );
      },
      { ...fast, attempts: 1 },
    ),
  ).rejects.toThrow(/failed \(interrupted\)/);
  expect(await readdir(root)).toEqual(["bundle.tgz.part"]);
  await downloadVerified(
    { ...options, signal: new AbortController().signal },
    async (_url, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=10-");
      return new Response(bytes.subarray(10), {
        status: 206,
        headers: {
          "content-range": `bytes 10-${bytes.length - 1}/${bytes.length}`,
        },
      });
    },
    fast,
  );
  expect(await readFile(output)).toEqual(bytes);
  expect(await readdir(root)).toEqual(["bundle.tgz"]);
});
