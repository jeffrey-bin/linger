import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { webSocketMessageText } from "../test-support/websocket-message-text.js";

it("drops actual Operation ACKs without blocking commands, and reconnects after a bounded disconnect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sx-ack-proxy-"));
  const ready = path.join(directory, "ready.json");
  const events = path.join(directory, "events.ndjson");
  const target = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(target, "listening");
  const address = target.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP address");
  const proxy = spawn(
    process.execPath,
    [
      path.resolve("tests/agent/fixtures/runner-gateway-proxy.mjs"),
      "--listen-port",
      "0",
      "--target-port",
      String(address.port),
      "--ready-file",
      ready,
      "--events-file",
      events,
    ],
    { stdio: "pipe" },
  );
  const exited = once(proxy, "exit");
  const clients: WebSocket[] = [];
  const upstreams: WebSocket[] = [];
  const messages: string[] = [];
  let diagnostics = "";
  proxy.stderr?.on("data", (data) => {
    diagnostics += String(data);
  });
  target.on("connection", (socket) => upstreams.push(socket));
  const records = async () =>
    (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  try {
    let port = 0;
    await vi.waitFor(async () => {
      port = JSON.parse(await readFile(ready, "utf8")).port;
      expect(port).toBeGreaterThan(0);
    });
    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/runner-gateway`);
      clients.push(socket);
      socket.on("message", (data) => messages.push(webSocketMessageText(data)));
      await once(socket, "open");
      await vi.waitFor(() => expect(upstreams).toHaveLength(clients.length));
      return socket;
    };
    const client = await connect();
    const received = once(upstreams[0]!, "message");
    client.send(
      JSON.stringify({ type: "daemon.hello", token: "private-proxy-token" }),
    );
    expect((await received)[0].toString()).toContain("private-proxy-token");
    proxy.kill("SIGUSR2");
    await vi.waitFor(async () =>
      expect(await records()).toContainEqual(
        expect.objectContaining({ mode: "operation_ack_only" }),
      ),
    );
    const ack = {
      type: "operation.ack",
      operation_id: "operation-proof",
      through_seq: 9,
    };
    upstreams[0]!.send(JSON.stringify(ack));
    upstreams[0]!.send(
      JSON.stringify({
        type: "cancel",
        target: "operation",
        operation_id: "operation-proof",
      }),
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(JSON.parse(messages[0]!)).toMatchObject({
      type: "cancel",
      target: "operation",
    });
    expect(await records()).toContainEqual(
      expect.objectContaining({
        type: "blocked_agent_to_daemon",
        message_type: "operation.ack",
        operation_id: "operation-proof",
        through_seq: 9,
      }),
    );
    const closed = once(client, "close");
    proxy.kill("SIGUSR1");
    await closed;
    await connect();
    upstreams[1]!.send(JSON.stringify(ack));
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(JSON.parse(messages[1]!)).toEqual(ack);
    expect(await readFile(events, "utf8")).not.toContain("private-proxy-token");
    expect(diagnostics).toBe("");
  } finally {
    for (const client of clients) client.terminate();
    for (const upstream of upstreams) upstream.terminate();
    proxy.kill("SIGTERM");
    const timer = setTimeout(() => proxy.kill("SIGKILL"), 3000);
    await exited.finally(() => clearTimeout(timer));
    await new Promise<void>((resolve) => target.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
