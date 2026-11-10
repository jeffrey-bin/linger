import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

// A spawned fixture process boots Node and imports its modules before it
// writes the ready file; under CI load that takes seconds, far beyond
// expect.poll's 1 s default. Early exit still fails immediately.
const FIXTURE_STARTUP_TIMEOUT_MS = 15_000;

describe("Local Runner smoke entrypoints", () => {
  it.each(["activation.completed", "activation.failed"])(
    "requires successful activation before offline removal: %s",
    async (event) => {
      const source = await readFile(
        path.join(root, "scripts/smoke-local-runner.sh"),
        "utf8",
      );
      const start = source.indexOf("wait_for_agent_activation() {");
      const end = source.indexOf(
        "\nwait_for_gateway_connection_count()",
        start,
      );
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const home = await mkdtemp(path.join(os.tmpdir(), "sx-activation-"));
      try {
        const logs = path.join(
          home,
          "agent-home/agent-manager/logs/agents/agent-test",
        );
        await mkdir(logs, { recursive: true });
        await writeFile(
          path.join(logs, "events.ndjson"),
          `${JSON.stringify({
            agentId: "agent-test",
            event,
          })}\n`,
        );
        const script = path.join(home, "activation.sh");
        await writeFile(
          script,
          `set -Eeuo pipefail\n${source.slice(start, end)}\nwait_for_agent_activation agent-test\nprintf 'ready to stop Daemon\\n'\n`,
        );
        const result = await runScript(script, [], { TMP_ROOT: home });
        expect(result.code).toBe(event === "activation.completed" ? 0 : 1);
        expect(result.stdout).toBe(
          event === "activation.completed" ? "ready to stop Daemon\n" : "",
        );
        if (event === "activation.failed")
          expect(result.stderr).toContain(
            "Activation failed for Agent agent-test",
          );
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it.each([true, false])(
    "answers Claude initialization before a user turn (probe=%s)",
    async (probe) => {
      const home = await mkdtemp(path.join(os.tmpdir(), "claude-smoke-probe-"));
      try {
        const marker = path.join(home, ".linger-smoke-marker");
        await writeFile(marker, "fixture workspace");
        const child = spawn(
          process.execPath,
          [
            path.join(
              root,
              "scripts/test-fixtures/claude-runtime-auth-fixture.mjs",
            ),
            "--linger-login-marker",
            marker,
            ...(probe ? ["--bare"] : []),
          ],
          { cwd: home, stdio: ["pipe", "pipe", "pipe"] },
        );
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk;
        });
        const exited = once(child, "exit");
        child.stdin.end(
          [
            JSON.stringify({
              type: "control_request",
              request_id: "probe-id",
              request: { subtype: "initialize" },
            }),
            ...(probe
              ? []
              : [
                  JSON.stringify({
                    type: "user",
                    uuid: "smoke-turn-id",
                    message: { role: "user", content: "run" },
                  }),
                ]),
            "",
          ].join("\n"),
        );
        expect((await exited)[0]).toBe(0);
        const frames = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(frames).toContainEqual({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "probe-id",
            response: {
              models: [
                {
                  value: "claude-default",
                  displayName: "Claude fixture",
                  supportsEffort: true,
                  supportedEffortLevels: ["medium"],
                },
              ],
            },
          },
        });
        if (!probe)
          expect(frames).toContainEqual(
            expect.objectContaining({
              type: "user",
              uuid: "smoke-turn-id",
              isReplay: true,
            }),
          );
        expect(frames.filter((frame) => frame.type === "result")).toEqual(
          probe
            ? []
            : [
                expect.objectContaining({
                  result: "fixture complete:fixture workspace",
                }),
              ],
        );
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("publishes stable package commands", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["smoke:local-runner"]).toBe(
      "bash scripts/smoke-local-runner.sh",
    );
    expect(packageJson.scripts["smoke:local-runner:soak"]).toBe(
      "LINGER_LOCAL_RUNNER_SOAK_ONLY=1 bash scripts/smoke-local-runner-live.sh",
    );
    expect(packageJson.scripts["smoke:local-runner:live"]).toBe(
      "bash scripts/smoke-local-runner-live.sh",
    );
    const deterministicSmoke = await readFile(
      path.join(root, "scripts/smoke-local-runner.sh"),
      "utf8",
    );
    // Cloud startup now verifies account/read; `true` is not a protocol fixture.
    expect(deterministicSmoke).toContain('CODEX_CLI_PATH="$CODEX_FIXTURE"');
    expect(deterministicSmoke).toContain(
      "runtime_paths: {codex: $codex, claude: $claude, pi: $pi}",
    );
  });

  it.each([0, 7])(
    "requires the Agent Service to exit successfully before a smoke restart: exit %s",
    async (exitCode) => {
      const source = await readFile(
        path.join(root, "scripts/smoke-local-runner-live.sh"),
        "utf8",
      );
      const start = source.indexOf("\nstop_agent_service() {");
      const end = source.indexOf("\nstart_agent_service() {", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const home = await mkdtemp(path.join(os.tmpdir(), "sx-live-stop-"));
      const script = path.join(home, "stop.sh");
      await writeFile(
        script,
        `#!/usr/bin/env bash
set -Eeuo pipefail
AGENT_PID=""
trap 'if [[ -n "$AGENT_PID" ]]; then kill "$AGENT_PID" 2>/dev/null || true; wait "$AGENT_PID" 2>/dev/null || true; fi' EXIT
${source.slice(start, end)}
${JSON.stringify(process.execPath)} -e '
  process.on("SIGTERM", () => process.exit(Number(process.env.SHUTDOWN_EXIT_CODE)));
  require("node:fs").writeFileSync(process.env.READY_FILE, "ready");
  setInterval(() => {}, 1000);
' &
AGENT_PID=$!
for attempt in {1..100}; do
  [[ -f "$READY_FILE" ]] && break
  sleep 0.01
done
[[ -f "$READY_FILE" ]]
stop_agent_service
printf 'restart-allowed\\n'
`,
      );
      try {
        const result = await runScript(script, [], {
          READY_FILE: path.join(home, "ready"),
          SHUTDOWN_EXIT_CODE: String(exitCode),
        });
        expect(result.code).toBe(exitCode);
        if (exitCode === 0) {
          expect(result.stdout).toContain("restart-allowed");
        } else {
          expect(result.stdout).not.toContain("restart-allowed");
          expect(result.stderr).toContain("Agent Service exited with code 7");
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("keeps the release and deterministic smoke on the Go-only daemon path", async () => {
    const computerPackage = JSON.parse(
      await readFile(path.join(root, "apps/computer/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const deterministicSmoke = await readFile(
      path.join(root, "scripts/smoke-local-runner.sh"),
      "utf8",
    );
    const installer = await readFile(
      path.join(root, "scripts/install-linger-computer.sh"),
      "utf8",
    );
    const releaseBuilder = await readFile(
      path.join(root, "scripts/prepare-local-computer-release.mjs"),
      "utf8",
    );
    const bundleBuilder = await readFile(
      path.join(root, "apps/computer/scripts/bundle.mjs"),
      "utf8",
    );

    expect(computerPackage.scripts.bundle).toBe("node scripts/bundle.mjs");
    expect(bundleBuilder).toContain("daemon/linger-computer-daemon");
    expect(bundleBuilder).toContain("./cmd/linger-computer-daemon");
    expect(bundleBuilder).not.toContain("daemon-entry");
    expect(bundleBuilder).not.toContain("operation-child");
    expect(deterministicSmoke).toContain("./cmd/linger-computer-daemon");
    expect(deterministicSmoke).not.toContain("local-runner-daemon.mjs");
    for (const source of [installer, releaseBuilder]) {
      expect(source).toContain("daemon/linger-computer-daemon");
    }
    expect(releaseBuilder).not.toContain("daemon/daemon-entry.js");
    expect(releaseBuilder).not.toContain("runner/operation-child.js");
    expect(installer).not.toContain("daemon/daemon-entry.js");
    expect(installer).not.toContain("runner/operation-child.js");
  });

  it("keeps the billable live smoke on the current Execution Context architecture", async () => {
    const liveSmoke = await readFile(
      path.join(root, "scripts/smoke-local-runner-live.sh"),
      "utf8",
    );
    const fixture = await readFile(
      path.join(
        root,
        "apps/node-services/tests/agent/fixtures/local-runner-stage-c-teamhub-fixture.mjs",
      ),
      "utf8",
    );

    expect(liveSmoke).toContain("inbox-state.json");
    expect(liveSmoke).not.toContain("authorization/actors.json");
    expect(liveSmoke).toContain("teamhub docs get document_live_input");
    expect(liveSmoke).not.toContain("stage_c_verifier");
    expect(liveSmoke).not.toContain("list_tasks");
    expect(liveSmoke).not.toContain("--mcp-server-token");
    expect(fixture).not.toContain("/v1/mcp-context/");
    expect(fixture).toContain("/access-credentials");
    expect(fixture).toContain("/api/agent/v1/messages");
    expect(fixture).toContain("/api/agent/v1/files");
    expect(liveSmoke).toContain("resources: {skills: [], mcpServers: []}");
    expect(liveSmoke).not.toContain('skillId: "skill-stage-c"');
    expect(liveSmoke).not.toContain('mcpId: "stage_c_verifier"');
    expect(liveSmoke).toContain("Context Generation Skill resources");
    expect(liveSmoke).toContain("Agent Service deferred restore");
    expect(liveSmoke).toContain("teamhub publish");
    expect(liveSmoke).toContain("teamhub update");
    expect(liveSmoke).not.toContain("local-mcp-audits");
    expect(liveSmoke).not.toContain("local_mcp_relay_audit");
    expect(liveSmoke).toContain("artifact.published");
    expect(liveSmoke).toContain("block_agent_to_daemon");
    expect(liveSmoke).toContain("wait_for_local_run_terminal");
    expect(liveSmoke).toContain("wait_for_operation_receipt");
    expect(liveSmoke).not.toContain("causationMessageIds");
    expect(liveSmoke).toContain("wait_for_active_operation");
    expect(liveSmoke).toContain("exec sleep 3600");
    expect(liveSmoke).toContain("wait_for_hold_command_exit");
    expect(
      liveSmoke.match(/verify_hold_reconnect_cancel [13]\n/gu),
    ).toHaveLength(2);
    expect(liveSmoke).toContain("wait_for_runner_state");
    expect(liveSmoke).toContain("stop_agent_service");
    expect(liveSmoke).toContain(
      'publish_inbox_state "$REVISION" "$ACTOR_ID" 0',
    );
    expect(liveSmoke).not.toContain("TaskProjectionUnavailableError");
    expect(liveSmoke).not.toContain("LocalComputerOfflineError");
    expect(liveSmoke).toContain(
      'wait_for_http "http://127.0.0.1:$AGENT_PORT/readyz"',
    );
    expect(liveSmoke).toContain("$exit_code -ne 0");
    expect(liveSmoke).not.toContain('wait "$DAEMON_PID"');
    expect(liveSmoke).toContain("queue_task_turn");
    expect(liveSmoke).not.toContain("inbox_id room:$ROOM_ID");
    expect(liveSmoke).toContain("message_segments");
    expect(liveSmoke).toContain("assert_unique_final_message");
    expect(liveSmoke.match(/assert_unique_final_message/gu)).toHaveLength(7);
    expect(liveSmoke).toContain("local-runner-message-evidence.mjs");
    expect(liveSmoke).not.toContain("wait_for_published_messages");
    expect(liveSmoke).not.toContain("wait_for_audit");
    expect(fixture).toContain("skill.package.downloaded");
    expect(fixture).toContain('skill_id: "skill-stage-c"');
    expect(fixture).toContain("/mcp-context\\/actions\\/resolve");
    expect(fixture).not.toContain("/mcp-context\\/actions\\/revoke");
    expect(fixture).toContain("\\/skills\\/packages\\/");
    expect(fixture).not.toContain("\\/skill-packages\\/");
    expect(fixture).not.toContain("has_external_mcp_servers");
    expect(fixture).not.toContain("mcp_id:");
    expect(liveSmoke).toContain("runtime_state_to_file");
    expect(liveSmoke).toContain("LINGER_LOCAL_RUNNER_SOAK_ONLY");
    expect(liveSmoke).toContain("for iteration in {1..20}");
    expect(liveSmoke).toContain("Unsettled daemon ledger rows");
    expect(liveSmoke).toContain("mcp_ctx_[A-Za-z0-9_-]{43}");
    expect(fixture).not.toContain(
      "\\/skills\\/([^/]+)\\/versions\\/([^/]+)\\/package",
    );
    expect(fixture).toContain('"content-type": "application/zip"');
    expect(fixture).toContain("base_version_id");
    expect(fixture).toContain("/v0/task-execution-claims");
    expect(fixture).toContain('case "record_agent_turn"');
    expect(fixture).toContain("/__test__/task-cancel");
    expect(fixture).toContain('operation: "cleanup_runtime"');
    expect(fixture).toContain('case "complete_runtime_cleanup"');

    for (const obsolete of [
      "/v0/agent-runs",
      "transfer-capabilities",
      "selection.capture",
      "selection.complete",
      "run.completed",
      "runGrant",
      "runSkillSnapshot",
      "runMcpSnapshot",
      "mcp_snapshot",
      "mcp_grants",
      "teamhub_run.materialize_artifact",
      "accessToken",
      "runners start",
    ]) {
      expect(liveSmoke).not.toContain(obsolete);
      expect(fixture).not.toContain(obsolete);
    }
  });

  it("tracks the native hold command by its PID until it stops", async () => {
    const source = await readFile(
      path.join(root, "scripts/smoke-local-runner-live.sh"),
      "utf8",
    );
    const command = /Run exactly one shell command: (.+?) \. It never finishes/u
      .exec(source)?.[1]
      ?.replaceAll("\\$", "$");
    expect(command).toBe(
      "mkdir -p ./playground && echo $$ > ./playground/stage-c-hold.pid && exec sleep 3600",
    );
    const start = source.indexOf("\nwait_for_hold_command() {");
    const end = source.indexOf("\n# A long native command keeps", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const home = await mkdtemp(path.join(os.tmpdir(), "sx-live-hold-"));
    const script = path.join(home, "hold.sh");
    // The detached command is reparented like a Runtime's background
    // terminal, so its exit is observable through kill -0.
    await writeFile(
      script,
      `#!/usr/bin/env bash
set -Eeuo pipefail
HOLD_PID=""
HOLD_PID_FILE=""
trap '[[ -z "$HOLD_PID" ]] || kill "$HOLD_PID" 2>/dev/null || true' EXIT
${source.slice(start, end)}
mkdir -p "$TMP_ROOT/context-view"
(cd "$TMP_ROOT/context-view" && bash -c "$HOLD_COMMAND" >/dev/null 2>&1 &)
wait_for_hold_command
[[ "$HOLD_PID_FILE" == "$TMP_ROOT/context-view/playground/stage-c-hold.pid" ]]
[[ "$(ps -o comm= -p "$HOLD_PID")" == *sleep ]]
kill "$HOLD_PID"
wait_for_hold_command_exit
[[ -z "$HOLD_PID" ]]
printf 'hold-stopped\\n'
`,
    );
    try {
      const result = await runScript(script, [], {
        TMP_ROOT: home,
        HOLD_COMMAND: command!,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("hold-stopped");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    {
      selected: "gpt-5.6-luna",
      available: ["gpt-5.6-luna"],
      expected: "gpt-5.6-luna",
    },
    { selected: "", available: ["codex-default"], expected: "codex-default" },
    {
      selected: "gpt-5.6-luna",
      available: ["another-model"],
      expected: undefined,
    },
    {
      selected: "gpt-5.6-luna",
      available: ["gpt-5.6-luna"],
      expected: "gpt-5.6-luna",
      allowed: ["low", "medium", "max"],
      defaultEffort: "medium",
      expectedEffort: "medium",
    },
    {
      selected: "gpt-5.6-luna",
      available: ["gpt-5.6-luna"],
      expected: "gpt-5.6-luna",
      allowed: ["low", "medium", "max"],
      defaultEffort: "medium",
      requestedEffort: "max",
      expectedEffort: "max",
    },
    {
      selected: "gpt-5.6-luna",
      available: ["gpt-5.6-luna"],
      expected: undefined,
      allowed: ["low", "medium", "max"],
      requestedEffort: "ultra",
      error: "Selected live Codex reasoning effort is unavailable",
    },
    {
      selected: "gpt-5.6-luna",
      available: ["gpt-5.6-luna"],
      expected: undefined,
      allowed: ["low", "max"],
      error: "Selected live Codex model has no valid default reasoning effort",
    },
    {
      selected: "",
      available: ["codex-default"],
      expected: undefined,
      requestedEffort: "max",
      error: "An explicit live model is required",
    },
  ])(
    "preserves the live model request or fails before registration: $selected/$available",
    async ({
      selected,
      available,
      expected,
      allowed = [],
      defaultEffort,
      requestedEffort = "",
      expectedEffort,
      error,
    }) => {
      const source = await readFile(
        path.join(root, "scripts/smoke-local-runner-live.sh"),
        "utf8",
      );
      const startMarker = "\nwait_for_runtime_ready codex\n";
      const start = source.indexOf(startMarker) + startMarker.length;
      const end = source.indexOf("\ncurl --fail-with-body", start);
      expect(start).toBeGreaterThan(startMarker.length);
      expect(end).toBeGreaterThan(start);
      const home = await mkdtemp(path.join(os.tmpdir(), "sx-live-model-"));
      const script = path.join(home, "register.sh");
      await writeFile(
        script,
        `#!/usr/bin/env bash\nset -Eeuo pipefail\ncomputer() { printf '%s\\n' "$RUNTIME_CATALOG_JSON"; }\n${source.slice(start, end)}\nprintf '%s\\n' "$REGISTRATION"\n`,
      );
      try {
        const result = await runScript(script, [], {
          LIVE_MODEL: selected,
          LIVE_REASONING_EFFORT: requestedEffort,
          TENANT_ID: "tenant-test",
          OWNER_ACTOR_ID: "actor-test",
          COMPUTER_ID: "computer-test",
          RUNTIME_CATALOG_JSON: JSON.stringify({
            runtimes: [
              {
                type: "codex",
                status: "ready",
                models: available.map((id) => ({
                  id,
                  allowed_reasoning_effort: allowed,
                  ...(defaultEffort
                    ? { default_reasoning_effort: defaultEffort }
                    : {}),
                })),
              },
            ],
          }),
        });
        if (expected === undefined) {
          expect(result.code).not.toBe(0);
          expect(result.stderr).toContain(
            error ?? "Selected live Codex model is unavailable",
          );
          expect(result.stdout).toBe("");
        } else {
          expect(result.code, result.stderr).toBe(0);
          expect(JSON.parse(result.stdout)).toMatchObject({
            runtime: {
              model: expected,
              ...(expectedEffort ? { reasoningEffort: expectedEffort } : {}),
              placement: { type: "local", runtimeType: "codex" },
            },
          });
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("configures stable Agent credentials in the deterministic smoke fixture", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "sx-smoke-cli-credential-"),
    );
    await writeFile(
      path.join(home, "inbox-state.json"),
      JSON.stringify({
        tenant_id: "tenant-fixture",
        inboxes: [
          {
            inbox_id: "room:room-fixture",
            kind: "room",
            room_id: "room-fixture",
            actor_ids: ["actor-agent-fixture"],
            messages: [],
          },
        ],
      }),
    );
    const reserved = createServer();
    const origin = await listen(reserved);
    await close(reserved);
    const readyFile = path.join(home, "ready");
    const child = spawn(
      process.execPath,
      [
        path.join(
          root,
          "apps/node-services/tests/agent/fixtures/teamhub-callback-fixture.mjs",
        ),
        "--port",
        new URL(origin).port,
        "--ready-file",
        readyFile,
        "--output-file",
        path.join(home, "events.ndjson"),
        "--service-token",
        "fixture-service-only",
        "--tenant-id",
        "tenant-fixture",
        "--inbox-state-file",
        path.join(home, "inbox-state.json"),
      ],
      { cwd: root, stdio: "ignore" },
    );
    const issue = (agent: string, token = "fixture-service-only") =>
      fetch(`${origin}/internal/agents/${agent}/access-credentials`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
    try {
      await expect
        .poll(
          () => {
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error("TeamHub callback fixture exited before ready");
            return access(readyFile).then(
              () => true,
              () => false,
            );
          },
          { timeout: FIXTURE_STARTUP_TIMEOUT_MS },
        )
        .toBe(true);
      expect((await issue("agent-one", "wrong-service")).status).toBe(401);
      const first = await issue("agent-one");
      expect(first.status).toBe(201);
      const credential = (await first.json()) as {
        access_token: string;
        expires_at: string;
      };
      expect(credential).toMatchObject({
        tenant_id: "tenant-fixture",
        agent_id: "agent-one",
      });
      expect(credential.access_token).toMatch(/^th_agent_[A-Za-z0-9_-]{43}$/);
      expect(Date.parse(credential.expires_at)).toBeGreaterThan(
        Date.now() + 47 * 3_600_000,
      );
      expect(await (await issue("agent-one")).json()).toEqual(credential);
      expect((await (await issue("agent-two")).json()).access_token).not.toBe(
        credential.access_token,
      );
      const retiredAttempts = () =>
        fetch(`${origin}/__test__/retired-invocation-requests`, {
          headers: { authorization: "Bearer fixture-service-only" },
        });
      const baseline = await retiredAttempts();
      expect(baseline.status).toBe(200);
      expect(await baseline.json()).toEqual({ count: 0 });
      const retired = await fetch(`${origin}/v0/agents/agent-one/invocations`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-service-only",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          request_id: "retired-request",
          room_id: "room-fixture",
          message_ids: ["message-fixture"],
        }),
      });
      expect(retired.status).toBe(404);
      expect(await (await retiredAttempts()).json()).toEqual({ count: 1 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await rm(home, { force: true, recursive: true });
    }
  });

  it("accepts an existing config-only Codex home without inventing an auth file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "sx-live-codex-home-"));
    try {
      await writeFile(
        path.join(home, "config.toml"),
        'model_provider = "custom"\n',
      );
      const source = await readFile(
        path.join(root, "scripts/smoke-local-runner-live.sh"),
        "utf8",
      );
      const resolver = source.match(
        /resolve_live_codex_home\(\) \{[\s\S]*?\n\}/u,
      )?.[0];
      expect(resolver).toBeDefined();
      const resolveHome = async (
        explicitAuthFile = "",
        authFile = path.join(home, "auth.json"),
      ) => {
        const child = spawn(
          "bash",
          [
            "-c",
            `${resolver}\nresolve_live_codex_home || exit $?\nprintf '%s\n%s' "$LIVE_CODEX_HOME" "$AUTH_FILE"`,
          ],
          {
            env: {
              ...process.env,
              LIVE_CODEX_HOME: home,
              AUTH_FILE: authFile,
              LINGER_CODEX_AUTH_FILE: explicitAuthFile,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.resume();
        return { code: (await once(child, "exit"))[0], stdout };
      };
      expect(await resolveHome()).toEqual({ code: 0, stdout: `${home}\n` });
      await expect(access(path.join(home, "auth.json"))).rejects.toThrow();
      expect(
        (await resolveHome(path.join(home, "missing-auth.json"))).code,
      ).toBe(2);
      await rm(path.join(home, "config.toml"));
      expect((await resolveHome()).code).toBe(2);
      const authFile = path.join(home, "auth.json");
      await writeFile(authFile, "fixture-auth");
      expect(await resolveHome(authFile)).toEqual({
        code: 0,
        stdout: `${home}\n${authFile}`,
      });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  it("uses direct CLI business credentials and rejects wrong targets in the live fixture", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "sx-live-cli-schema-"));
    await writeFile(
      path.join(home, "inbox-state.json"),
      JSON.stringify({
        tenant_id: "tenant-fixture",
        inboxes: [
          {
            inbox_id: "room:room-fixture",
            kind: "room",
            room_id: "room-fixture",
            actor_ids: ["actor-agent-fixture"],
            messages: [],
          },
        ],
      }),
    );
    const reserved = createServer();
    const origin = await listen(reserved);
    await close(reserved);
    const readyFile = path.join(home, "ready");
    const reportFile = path.join(home, "events.ndjson");
    const child = spawn(
      process.execPath,
      [
        path.join(
          root,
          "apps/node-services/tests/agent/fixtures/local-runner-stage-c-teamhub-fixture.mjs",
        ),
        "--port",
        new URL(origin).port,
        "--ready-file",
        readyFile,
        "--report-file",
        reportFile,
        "--artifact-directory",
        path.join(home, "documents"),
        "--service-token",
        "fixture-service-only",
        "--tenant-id",
        "tenant-fixture",
        "--inbox-state-file",
        path.join(home, "inbox-state.json"),
      ],
      { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const servicePost = (route: string, body: unknown) =>
      fetch(origin + route, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-service-only",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    try {
      await expect
        .poll(
          () => {
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error(
                `Live CLI fixture exited before ready: ${stderr}`,
              );
            return access(readyFile).then(
              () => true,
              () => false,
            );
          },
          { timeout: FIXTURE_STARTUP_TIMEOUT_MS },
        )
        .toBe(true);
      const credentialRoute =
        "/internal/agents/agent-fixture/access-credentials";
      expect((await servicePost(credentialRoute, {})).status).toBe(400);
      await servicePost("/__test__/runtime-configs", {
        registration: {
          agentId: "agent-fixture",
          tenantId: "tenant-fixture",
          revision: "1",
          agent: { name: "Fixture Agent", instructions: "Test only" },
          runtime: {
            model: "fixture",
            placement: {
              type: "local",
              tenantId: "tenant-fixture",
              ownerActorId: "human-fixture",
              computerId: "computer-fixture",
              runtimeType: "codex",
              workspaceGrantId: "grant-fixture",
            },
          },
          resources: { skills: [], mcpServers: [] },
        },
      });
      const registrations = (await (
        await fetch(origin + "/v0/agent-runtime/local-runtime-registrations", {
          headers: { authorization: "Bearer fixture-service-only" },
        })
      ).json()) as { registrations: { registration_id: string }[] };
      const registrationId = registrations.registrations[0].registration_id;
      const issueInput = { label: "Stage C" };
      expect(
        (
          await servicePost("/v0/agent-runtime/assignments/set", {
            agent_management_id: "agent-fixture",
            agent_actor_id: "actor-agent-fixture",
            tenant_id: "tenant-fixture",
            registration_id: registrationId,
            expected_revision: "0",
            state: "bound",
          })
        ).status,
      ).toBe(200);
      const issued = await servicePost(credentialRoute, issueInput);
      expect(issued.status, stderr).toBe(201);
      const credential = (await issued.json()) as {
        credential_id: string;
        access_token: string;
        expires_at: string;
      };
      expect(Date.parse(credential.expires_at)).toBeGreaterThan(
        Date.now() + 47 * 3_600_000,
      );
      const resolved = await servicePost(
        "/internal/agents/agent-fixture/mcp-context/actions/resolve",
        { context: { kind: "meta", room_id: "room-fixture" } },
      );
      expect(resolved.status, stderr).toBe(200);
      expect(await resolved.json()).toEqual({
        agent_id: "agent-fixture",
        context: { kind: "meta", room_id: "room-fixture" },
      });
      const invoke = (
        body: unknown,
        target = "room-fixture",
        token = credential.access_token,
        operation = "message-proof",
      ) =>
        fetch(origin + "/api/agent/v1/messages", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-teamhub-context-kind": "room",
            "x-teamhub-context-id": target,
            "x-teamhub-operation-id": operation,
          },
          body: JSON.stringify(body),
        });
      const input = {
        inbox_id: "room:room-fixture",
        message_segments: [{ type: "text", content: "SCHEMA_OK" }],
      };
      expect((await invoke(input, "room-other")).status).toBe(403);
      expect(
        (await invoke(input, "room-fixture", "fixture-service-only")).status,
      ).toBe(401);
      expect(
        (
          await invoke({
            inbox_id: "room-fixture",
            message_segments: input.message_segments,
          })
        ).status,
      ).toBe(400);
      const accepted = await invoke(input);
      expect(accepted.status, stderr).toBe(200);
      const result = await accepted.json();
      expect(await (await invoke(input)).json()).toEqual(result);
      expect(
        (
          await invoke({
            ...input,
            message_segments: [{ type: "text", content: "changed" }],
          })
        ).status,
      ).toBe(409);
      const advanceClock = (advanceMs: number) =>
        servicePost("/__test__/agent-credentials/clock", {
          advance_ms: advanceMs,
        });
      await advanceClock(24 * 3_600_000);
      const secondResponse = await servicePost(credentialRoute, issueInput);
      expect(secondResponse.status).toBe(201);
      const second = (await secondResponse.json()) as typeof credential;
      expect(second.credential_id).not.toBe(credential.credential_id);
      expect(second.access_token).not.toBe(credential.access_token);
      // Issuing a new independent credential never expires the earlier token.
      expect((await invoke(input)).status).toBe(200);
      expect(
        (await invoke(input, "room-fixture", second.access_token)).status,
      ).toBe(200);
      await advanceClock(24 * 3_600_000);
      expect((await invoke(input)).status).toBe(401);
      expect(
        (await invoke(input, "room-fixture", second.access_token)).status,
      ).toBe(200);
      await advanceClock(24 * 3_600_000);
      expect(
        (await invoke(input, "room-fixture", second.access_token)).status,
      ).toBe(401);
      const replacementResponse = await servicePost(
        credentialRoute,
        issueInput,
      );
      expect(replacementResponse.status).toBe(201);
      const replacement =
        (await replacementResponse.json()) as typeof credential;
      expect(
        (await invoke(input, "room-fixture", replacement.access_token)).status,
      ).toBe(200);
      // The retired replacement-CAS protocol is no longer exposed.
      expect(
        (
          await servicePost(
            `${credentialRoute}/${second.credential_id}/renew`,
            {},
          )
        ).status,
      ).toBe(404);
      const events = (await readFile(reportFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.filter((event) => event.type === "agent.messages.published"),
      ).toEqual([
        expect.objectContaining({
          room_id: "room-fixture",
          transport: "teamhub-cli",
          command_operation_id: "message-proof",
          body_sha256: createHash("sha256").update("SCHEMA_OK").digest("hex"),
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain(credential.access_token);
      expect(JSON.stringify(events)).not.toContain("SCHEMA_OK");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await rm(home, { force: true, recursive: true });
    }
  }, 15_000);
});

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Release fixture did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
};

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const runScript = async (
  script: string,
  args: readonly string[],
  environment: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn("bash", [script, ...args], {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
