#!/usr/bin/env node
// Registers this checkout's Local Computer the way a server Computer is
// connected from the Web Computers page: sign in as the local owner, create a
// PKCE enrollment, and exchange it once for the Runner credential. Writes the
// credential and its non-secret registration owner-only into the output
// directory. Never prints the password or the credential.
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

// The Web page uses the same placeholder: no loopback callback receives this
// code, the exchange below presents it directly.
const REDIRECT_URI = "http://127.0.0.1:9/callback";
// Right after the Agent Service starts, its Local Computer records may still
// be loading. TeamHub answers an exact replay of an exchange with the same
// Computer, so the exchange is retried rather than enrolling again.
const EXCHANGE_ATTEMPTS = 20;
const EXCHANGE_RETRY_MS = 500;

class RegistrationError extends Error {}

const { values } = parseArgs({
  options: {
    "teamhub-url": { type: "string" },
    "owner-file": { type: "string" },
    "display-name": { type: "string" },
    "output-directory": { type: "string" },
  },
});
for (const name of [
  "teamhub-url",
  "owner-file",
  "display-name",
  "output-directory",
]) {
  if (!values[name]) throw new Error(`--${name} is required`);
}
const teamhub = values["teamhub-url"].replace(/\/+$/u, "");

try {
  await register(await readOwner(values["owner-file"]));
} catch (error) {
  if (!(error instanceof RegistrationError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

async function readOwner(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    throw new RegistrationError(
      `The local owner file ${file} is missing. Run pnpm dev first; it creates the owner.`,
    );
  }
}

async function register(owner) {
  const session = await request("POST", "/v0/auth/login", {
    body: { identifier: owner.owner_email, password: owner.owner_password },
    action: "Sign in as the local owner",
  });
  const cookie = session.response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  try {
    const actors = session.body.identity.actors.filter(
      (actor) => actor.kind === "human",
    );
    if (actors.length !== 1) {
      throw new RegistrationError(
        `The local owner must belong to exactly one workspace; it belongs to ${actors.length}.`,
      );
    }
    const verifier = randomBytes(32).toString("base64url");
    const authorization = await request(
      "POST",
      `/v0/tenants/${encodeURIComponent(actors[0].tenant_id)}/local-computer-enrollments`,
      {
        cookie,
        body: {
          display_name: values["display-name"],
          redirect_uri: REDIRECT_URI,
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
        },
        action: "Create the Local Computer enrollment",
      },
    );
    const bundle = await exchange(authorization.body, verifier);
    const directory = path.resolve(values["output-directory"]);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writePrivateFile(
      path.join(directory, "runner-token"),
      bundle.gateway_token,
    );
    await writePrivateFile(
      path.join(directory, "runner-registration.json"),
      `${JSON.stringify(
        {
          computer_id: bundle.computer_id,
          tenant_id: bundle.tenant_id,
          gateway_url: bundle.gateway_url,
          credential_expires_at: bundle.credential_expires_at,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(
      `Registered Local Computer ${bundle.computer_id} in workspace ${bundle.tenant_id}\n`,
    );
  } finally {
    await fetch(`${teamhub}/v0/auth/logout`, {
      method: "POST",
      headers: { cookie },
    }).catch(() => undefined);
  }
}

async function exchange(authorization, verifier) {
  for (let attempt = 1; ; attempt += 1) {
    const exchanged = await request(
      "POST",
      `/v0/local-computer-enrollments/${encodeURIComponent(authorization.enrollment_id)}/exchange`,
      {
        body: {
          authorization_code: authorization.authorization_code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
        },
        action: "Exchange the Local Computer enrollment",
        retryable: attempt < EXCHANGE_ATTEMPTS,
      },
    );
    if (exchanged) return exchanged.body;
    await new Promise((resolve) => setTimeout(resolve, EXCHANGE_RETRY_MS));
  }
}

// Returns null only for a retryable failure: an unreachable TeamHub or a 5xx.
async function request(method, route, options) {
  let response;
  try {
    response = await fetch(`${teamhub}${route}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: JSON.stringify(options.body),
    });
  } catch (error) {
    if (options.retryable) return null;
    throw new RegistrationError(
      `${options.action} failed: TeamHub is unreachable at ${teamhub} (${error instanceof Error ? error.message : "network error"}). Start pnpm dev first.`,
    );
  }
  if (response.ok) return { response, body: await response.json() };
  if (response.status >= 500 && options.retryable) return null;
  const code = await response
    .json()
    .then((body) => body?.error?.code)
    .catch(() => undefined);
  throw new RegistrationError(
    `${options.action} failed: TeamHub answered ${response.status}${code ? ` ${code}` : ""}.`,
  );
}

async function writePrivateFile(file, contents) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}
