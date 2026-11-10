import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("a separate CLI process honors HTTP_PROXY and NO_PROXY without a service handshake", async () => {
  const requests: { url: string; authorization: string | undefined }[] = [];
  const proxy = createServer((request, response) => {
    requests.push({
      url: request.url!,
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ files: [] }));
  });
  let tunnels = 0;
  const directRequests: string[] = [];
  const direct = createServer((request, response) => {
    expect(request.headers.authorization).toBe(
      "Bearer th_agent_process_fixture",
    );
    directRequests.push(request.url!);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ files: [] }));
  });
  const directory = await mkdtemp(path.join(tmpdir(), "teamhub-process-"));
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => direct.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address();
  const directAddress = direct.address();
  assert(proxyAddress && typeof proxyAddress !== "string");
  assert(directAddress && typeof directAddress !== "string");
  proxy.on("connect", (request, socket, head) => {
    tunnels++;
    expect(request.url).toBe(`127.0.0.1:${directAddress.port}`);
    const upstream = connect(directAddress.port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  try {
    const launch = async (url: string, noProxy: string) =>
      promisify(execFile)(
        process.execPath,
        [
          "--use-env-proxy",
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(new URL("./main.ts", import.meta.url)),
          "docs",
          "list",
          "--json",
        ],
        {
          cwd: directory,
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            TEAMHUB_URL: url,
            TEAMHUB_TOKEN: "th_agent_process_fixture",
            HTTP_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
            http_proxy: `http://127.0.0.1:${proxyAddress.port}`,
            NO_PROXY: noProxy,
            no_proxy: noProxy,
          },
        },
      );
    expect(
      JSON.parse(
        (await launch(`http://127.0.0.1:${directAddress.port}`, "")).stdout,
      ),
    ).toEqual({ documents: [] });
    expect(tunnels + requests.length).toBe(1);
    expect(
      JSON.parse(
        (await launch(`http://127.0.0.1:${directAddress.port}`, "127.0.0.1"))
          .stdout,
      ),
    ).toEqual({ documents: [] });
    expect(tunnels + requests.length).toBe(1);
    expect(directRequests).toHaveLength(2 - requests.length);
    if (requests.length)
      expect(requests[0]).toEqual({
        url: `http://127.0.0.1:${directAddress.port}/api/agent/v1/files?after_id=&limit=100`,
        authorization: "Bearer th_agent_process_fixture",
      });
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => direct.close(() => resolve())),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
