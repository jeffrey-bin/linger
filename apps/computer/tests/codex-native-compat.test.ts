import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The native CLI talks only to a deterministic loopback model, without user credentials.
const executable = process.env.LINGER_CODEX_COMPAT_EXECUTABLE;
it.skipIf(!executable)(
  "runs a first native Codex turn with a tool and resumes it in a fresh process",
  async () => {
    // Native Codex refuses to create Linux sandbox helpers beneath /tmp.
    // Keep Go's disposable runtime homes under an owned private directory,
    // without reading the user's actual Codex home or disabling the sandbox.
    const home = await mkdtemp(
      path.join(os.homedir(), ".linger-codex-compat-"),
    );
    const requests: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [] }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(body);
        const commandTool = (body.tools ?? []).find(
          (tool: { name?: string }) =>
            tool.name === "exec_command" || tool.name === "shell",
        );
        const output =
          requests.length === 1 && commandTool
            ? [
                {
                  type: "function_call",
                  id: "fc_compat",
                  call_id: "call_compat",
                  name: commandTool.name,
                  arguments: JSON.stringify(
                    commandTool.name === "exec_command"
                      ? {
                          cmd: "printf linger-compat-tool",
                          max_output_tokens: 100,
                        }
                      : {
                          command: [
                            "/bin/sh",
                            "-c",
                            "printf linger-compat-tool",
                          ],
                          timeout_ms: 1000,
                        },
                  ),
                  status: "completed",
                },
              ]
            : [
                {
                  type: "message",
                  id: `msg_${requests.length}`,
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: "compatibility check complete",
                      annotations: [],
                    },
                  ],
                },
              ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        const send = (event: object) =>
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        send({
          type: "response.created",
          response: {
            id: `resp_${requests.length}`,
            status: "in_progress",
            output: [],
          },
        });
        for (const item of output)
          send({ type: "response.output_item.done", output_index: 0, item });
        send({
          type: "response.completed",
          response: {
            id: `resp_${requests.length}`,
            status: "completed",
            output,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        });
        response.end();
      })().catch((error: unknown) => {
        response.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test HTTP port");
    try {
      await promisify(execFile)(
        "go",
        [
          "test",
          "./internal/provider",
          "-run",
          "^TestNativeCodexFirstRunResume$",
          "-count=1",
        ],
        {
          cwd: path.resolve(import.meta.dirname, "../local-daemon"),
          env: {
            ...process.env,
            TMPDIR: home,
            LINGER_CODEX_COMPAT_EXECUTABLE: executable,
            LINGER_CODEX_COMPAT_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          },
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        },
      );
      expect(
        requests.some(
          (body) =>
            Array.isArray(body.input) &&
            body.input.some(
              (item) =>
                item.type === "function_call_output" &&
                item.call_id === "call_compat" &&
                typeof item.output === "string" &&
                item.output.includes("linger-compat-tool") &&
                !item.output.includes("failed"),
            ),
        ),
      ).toBe(true);
      expect(requests).toHaveLength(4);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  130_000,
);
