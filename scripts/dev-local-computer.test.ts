import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
const scriptPath = path.join(repositoryRoot, "scripts/dev-local-computer.sh");
const codexFixturePath = path.join(
  repositoryRoot,
  "scripts/test-fixtures/codex-runtime-fixture.mjs",
);
const temporaryDirectories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("dev Local Computer lifecycle script", () => {
  it("quotes jq object keys that are reserved by Debian jq 1.6", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain('--arg grant_label "$GRANT_LABEL"');
    expect(script).toContain('"label": $grant_label');
    expect(script).not.toContain("$label");
  });

  it("uses an existing config for control commands without Runner or Codex credentials", async () => {
    const root = await createTemporaryRoot();
    const fakeBin = path.join(root, "bin");
    const configPath = path.join(root, "computer.json");
    const fakeCli = path.join(fakeBin, "linger-computer");
    await writeFile(
      path.join(fakeBin, "node"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "\${@: -1}"\n`,
      { mode: 0o755 },
    );
    await writeFile(
      fakeCli,
      `#!/usr/bin/env bash\nprintf '{"state":"running"}\\n'\n`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(fakeBin, "jq"),
      "#!/usr/bin/env bash\nprintf 'jq must not run for control commands\\n' >&2\nexit 97\n",
      { mode: 0o755 },
    );
    await writeFile(
      configPath,
      JSON.stringify({ state_directory: path.join(root, "state") }),
    );

    const result = await runScript("status", {
      PATH: `${fakeBin}:/usr/bin:/bin`,
      HOME: root,
      LINGER_LOCAL_COMPUTER_CONFIG: configPath,
      LINGER_LOCAL_COMPUTER_CLI: fakeCli,
      // Run the script itself, not its environment loader through the fake node.
      LINGER_LOCAL_COMPUTER_ENV_LOADED: "1",
    });

    expect(result.stdout).toContain('"state":"running"');
    expect(result.stderr).not.toContain("jq must not run");
  });

  it("generates a config without requiring a Codex auth file", async () => {
    const root = await createTemporaryRoot();
    const configPath = path.join(root, "computer.json");
    await seedRegistration(root);

    await runScript("config", {
      ...configurationEnvironment(root, configPath),
      LINGER_CODEX_AUTH_FILE: path.join(root, "missing-auth.json"),
    });

    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      codex?: unknown;
      max_concurrent_operations?: number;
      runtime_paths: { codex?: string };
    };
    expect(config.codex).toBeUndefined();
    expect(config.max_concurrent_operations).toBeUndefined();
    expect(config.runtime_paths.codex).toBe(codexFixturePath);
  }, 30_000);

  it("writes a Computer-wide limit only when explicitly configured", async () => {
    const root = await createTemporaryRoot();
    const configPath = path.join(root, "computer.json");
    await seedRegistration(root);

    await runScript("config", {
      ...configurationEnvironment(root, configPath),
      LINGER_LOCAL_COMPUTER_MAX_CONCURRENT_RUNS: "4",
    });

    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      max_concurrent_operations?: number;
    };
    expect(config.max_concurrent_operations).toBe(4);
  }, 30_000);

  it("registers once through TeamHub as the local owner and reuses the stored credential", async () => {
    const root = await createTemporaryRoot();
    const configPath = path.join(root, "computer.json");
    const teamHub = await startTeamHubEnrollmentFixture();
    const environment = {
      ...configurationEnvironment(root, configPath),
      TEAMHUB_BASE_URL: teamHub.url,
      LINGER_LOCAL_COMPUTER_DISPLAY_NAME: "Dev Mac",
    };
    await writeFile(
      environment.LINGER_LOCAL_OWNER_FILE!,
      JSON.stringify({
        owner_email: "owner@linger.local",
        owner_password: "owner-test-password",
      }),
    );

    const first = await runScript("config", environment);
    const second = await runScript("config", environment);

    const tokenFile = path.join(root, "state/runner-token");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      runner_id: string;
      display_name: string;
      gateway: { url: string; token_file: string };
      workspace_grants: Array<{ tenant_id: string }>;
    };
    expect(config).toMatchObject({
      runner_id: "computer-fixture",
      display_name: "Dev Mac",
      gateway: {
        url: "ws://127.0.0.1:4319/v1/runner-gateway",
        token_file: tokenFile,
      },
      workspace_grants: [{ tenant_id: "tenant-owner" }],
    });
    expect(await readFile(tokenFile, "utf8")).toBe(teamHub.gatewayToken);
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    const registration = await readFile(
      path.join(root, "state/runner-registration.json"),
      "utf8",
    );
    expect(registration).not.toContain(teamHub.gatewayToken);
    // A retried exchange replays the one enrollment; the second run reuses it.
    expect(teamHub.requests).toEqual([
      "POST /v0/auth/login",
      "POST /v0/tenants/tenant-owner/local-computer-enrollments",
      "POST /v0/local-computer-enrollments/enrollment-fixture/exchange",
      "POST /v0/local-computer-enrollments/enrollment-fixture/exchange",
      "POST /v0/auth/logout",
    ]);
    for (const output of [first, second]) {
      for (const text of [output.stdout, output.stderr]) {
        expect(text).not.toContain("owner-test-password");
        expect(text).not.toContain(teamHub.gatewayToken);
      }
    }
  }, 30_000);

  it("fails without a local owner instead of registering another identity", async () => {
    const root = await createTemporaryRoot();
    const configPath = path.join(root, "computer.json");

    await expect(
      runScript("config", configurationEnvironment(root, configPath)),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Run pnpm dev first"),
    });
  });
});

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "linger-computer-script-"));
  temporaryDirectories.push(root);
  const fakeBin = path.join(root, "bin");
  await Promise.all([mkdir(path.join(root, "workspace")), mkdir(fakeBin)]);
  return root;
}

// The registration a previous start stored, so config needs no TeamHub.
async function seedRegistration(root: string): Promise<void> {
  const state = path.join(root, "state");
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, "runner-token"), "sr1.seeded.token", {
    mode: 0o600,
  });
  await writeFile(
    path.join(state, "runner-registration.json"),
    JSON.stringify({
      computer_id: "computer-seeded",
      tenant_id: "tenant-acme",
      gateway_url: "ws://127.0.0.1:4319/v1/runner-gateway",
      credential_expires_at: "2036-01-01T00:00:00.000Z",
    }),
  );
}

// TeamHub's owner sign-in and Local Computer enrollment routes. The first
// exchange answers 503, as while Agent Service still loads its Computers.
async function startTeamHubEnrollmentFixture() {
  const gatewayToken = "sr1.fixture-claims.fixture-signature";
  const authorizationCode = "a".repeat(43);
  const session = "teamhub_session=fixture-session";
  const requests: string[] = [];
  let challenge = "";
  let exchanges = 0;
  const server = createServer((request, response) => {
    void (async () => {
      requests.push(`${request.method} ${request.url}`);
      const body = await readJson(request);
      const reply = (status: number, value?: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(value === undefined ? undefined : JSON.stringify(value));
      };
      if (request.url === "/v0/auth/login") {
        if (
          body.identifier !== "owner@linger.local" ||
          body.password !== "owner-test-password"
        )
          return reply(401);
        response.setHeader("set-cookie", `${session}; Path=/; HttpOnly`);
        return reply(200, {
          identity: {
            actors: [
              { id: "actor-owner", tenant_id: "tenant-owner", kind: "human" },
            ],
          },
        });
      }
      if (request.url === "/v0/auth/logout") return reply(204);
      if (
        request.url === "/v0/tenants/tenant-owner/local-computer-enrollments"
      ) {
        if (
          request.headers.cookie !== session ||
          body.display_name !== "Dev Mac" ||
          body.redirect_uri !== "http://127.0.0.1:9/callback"
        )
          return reply(400);
        challenge = String(body.code_challenge);
        return reply(201, {
          enrollment_id: "enrollment-fixture",
          computer_id: "computer-fixture",
          authorization_code: authorizationCode,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (
        request.url ===
        "/v0/local-computer-enrollments/enrollment-fixture/exchange"
      ) {
        const verified =
          body.authorization_code === authorizationCode &&
          body.redirect_uri === "http://127.0.0.1:9/callback" &&
          createHash("sha256")
            .update(String(body.code_verifier))
            .digest("base64url") === challenge;
        if (!verified) return reply(404);
        exchanges += 1;
        if (exchanges === 1) return reply(503);
        return reply(200, {
          computer_id: "computer-fixture",
          tenant_id: "tenant-owner",
          gateway_url: "ws://127.0.0.1:4319/v1/runner-gateway",
          gateway_token: gatewayToken,
          credential_expires_at: "2036-01-01T00:00:00.000Z",
        });
      }
      return reply(404);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    gatewayToken,
    requests,
  };
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function configurationEnvironment(
  root: string,
  configPath: string,
): NodeJS.ProcessEnv {
  return {
    PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
    HOME: root,
    // Never reach a developer's TeamHub or read this checkout's owner.
    TEAMHUB_BASE_URL: "http://127.0.0.1:1",
    LINGER_LOCAL_OWNER_FILE: path.join(root, "local-owner.json"),
    LINGER_LOCAL_COMPUTER_WORKSPACE: path.join(root, "workspace"),
    LINGER_LOCAL_COMPUTER_STATE_DIRECTORY: path.join(root, "state"),
    LINGER_LOCAL_COMPUTER_CONFIG: configPath,
    LINGER_LOCAL_COMPUTER_SKIP_BUILD: "1",
    LINGER_CODEX_PATH: codexFixturePath,
  };
}

async function runScript(
  command: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("bash", [scriptPath, command], {
    cwd: repositoryRoot,
    env: {
      ...environment,
      LOCAL_ENV_FILE: path.join(os.tmpdir(), "missing-linger-env"),
    },
  });
}
