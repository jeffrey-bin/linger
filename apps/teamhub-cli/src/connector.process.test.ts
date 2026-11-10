import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
it("executes the built Connector CLI through a real HTTP boundary", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "connector-process-"));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      requests.push(req.url!);
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      let result: unknown;
      if (req.url === "/api/agent/v1/apps/account")
        result = {
          status: "ready",
          account: {
            connection_id: "connection_one",
            app_key: "gmail",
            display_name: "Proof",
            identity_label: "owner@example.test",
          },
        };
      else if (req.url === "/api/agent/v1/apps/tools/bind")
        result = {
          tools: [
            {
              tool_slug: "GMAIL_FETCH_EMAILS",
              tool_version: "20261015_00",
              app_key: "gmail",
              input_schema: {
                type: "object",
                required: ["max_results"],
                properties: { max_results: { type: "integer" } },
                additionalProperties: true,
              },
            },
          ],
        };
      else if (req.url === "/api/agent/v1/apps/tools/execute") {
        expect(body).toMatchObject({
          connection_id: "connection_one",
          tool_slug: "GMAIL_FETCH_EMAILS",
          arguments: { max_results: 20 },
        });
        result = {
          data: {
            messages: [
              {
                messageId: "message_one",
                subject: "Actual executable",
                sender: "Alice <alice@example.test>",
              },
            ],
          },
        };
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    })().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing listener");
    await exec(process.execPath, [
      fileURLToPath(new URL("../scripts/build-cli.mjs", import.meta.url)),
      "--outdir",
      path.join(directory, "dist"),
    ]);
    const result = await exec(
      process.execPath,
      [path.join(directory, "dist/teamhub.js"), "gmail", "list", "--json"],
      {
        cwd: directory,
        env: {
          ...process.env,
          TEAMHUB_URL: `http://127.0.0.1:${address.port}`,
          TEAMHUB_TOKEN: "th_agent_process_fixture",
        },
      },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      account: { connectionId: "connection_one" },
      messages: [{ messageId: "message_one" }],
      hasMore: false,
    });
    expect(requests).toEqual([
      "/api/agent/v1/apps/account",
      "/api/agent/v1/apps/tools/bind",
      "/api/agent/v1/apps/tools/execute",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
