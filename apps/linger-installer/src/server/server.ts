import { windowsPrivatePath } from "@linger/local-installation/windows-private";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chmod, lstat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeLauncher } from "./launcher.js";
import { coreAdapter } from "./core.js";
import { JobManager, type RunInstallation } from "./jobs.js";
import { privateDirectory, privateWrite } from "./storage.js";
import {
  instanceName,
  validateInput,
  validateModel,
  validateLocalModelsAuthority,
} from "./validation.js";
import { checkModel, openLocalTarget } from "./platform.js";
import { checkRuntimeModel } from "@linger/local-installation/managed-codex";
export interface ServerOptions {
  home: string;
  sourceRepo: string;
  // Set by the desktop client, which is this machine's Computer.
  externalComputer?: boolean;
  instanceName?: string;
  port?: number;
  webDir?: string;
  idleTimeoutMs?: number;
  dependencies?: Partial<ReturnType<typeof coreAdapter>> & {
    run?: RunInstallation;
  };
}
async function body(request: http.IncomingMessage): Promise<unknown> {
  if (
    request.headers["content-type"] &&
    !request.headers["content-type"].startsWith("application/json")
  )
    throw new Error("Invalid content type");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error("Input too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
export async function startInstallerServer(options: ServerOptions) {
  const stateDir = path.join(options.home, "installer");
  await privateDirectory(options.home);
  await privateDirectory(stateDir);
  const lockPath = path.join(stateDir, "manager.sqlite");
  const lockInfo = await lstat(lockPath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (
    lockInfo &&
    (lockInfo.isSymbolicLink() ||
      !lockInfo.isFile() ||
      (process.platform !== "win32" && lockInfo.uid !== process.getuid?.()))
  )
    throw new Error("Unsafe installer lock");
  const lock = new DatabaseSync(lockPath);
  try {
    if (process.platform === "win32")
      await windowsPrivatePath(lockPath, "file", true);
    else await chmod(lockPath, 0o600);
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if (error instanceof Error && error.message.includes("database is locked"))
      throw Object.assign(
        new Error("The installer is already running. Use its existing window."),
        {
          code: "INSTALLER_BUSY",
        },
      );
    throw error;
  }
  await rm(path.join(stateDir, "launch.html"), { force: true });
  const dependencies = {
    ...coreAdapter(options.home, options.sourceRepo, options.externalComputer),
    ...options.dependencies,
  };
  const jobs = new JobManager(path.join(stateDir, "jobs"), dependencies.run);
  await jobs.load().catch((error) => {
    lock.close();
    throw error;
  });
  const initialToken = randomBytes(32).toString("base64url");
  const bootstraps = new Map<string, number>([
    [initialToken, Date.now() + 30 * 60_000],
  ]);
  let launcherToken = initialToken;
  const controlToken = randomBytes(32).toString("base64url");
  const session = randomBytes(32).toString("base64url");
  let origin = "";
  let closing = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const json = (res: http.ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const error = (
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string,
  ) => json(res, status, { code, message });
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => {
        if (jobs.busy) touch();
        else void close();
      },
      options.idleTimeoutMs ?? 30 * 60_000,
    );
    idleTimer.unref();
  };
  const server = http.createServer(async (req, res) => {
    try {
      touch();
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      if (req.headers.host !== new URL(origin).host) {
        error(res, 403, "FORBIDDEN", "Local address validation failed.");
        return;
      }
      if (
        !["GET", "HEAD"].includes(req.method ?? "") &&
        req.headers.origin !== origin
      ) {
        error(res, 403, "FORBIDDEN", "Invalid request origin.");
        return;
      }
      const url = new URL(req.url ?? "/", origin),
        method = req.method;
      // Local-file launchers navigate across origins to the public HTML shell.
      // Session exchange and every API still require the normal origin checks.
      const launcherNavigation =
        method === "GET" &&
        ["/", "/index.html"].includes(url.pathname) &&
        req.headers["sec-fetch-mode"] === "navigate" &&
        req.headers["sec-fetch-dest"] === "document";
      if (
        req.headers["sec-fetch-site"] === "cross-site" &&
        !launcherNavigation
      ) {
        error(res, 403, "FORBIDDEN", "Invalid request origin.");
        return;
      }
      if (url.pathname === "/api/reopen" && method === "POST") {
        const input = (await body(req)) as { token?: unknown };
        if (input.token !== controlToken) {
          error(res, 401, "UNAUTHORIZED", "Open the installer again.");
          return;
        }
        const now = Date.now();
        for (const [token, expiry] of bootstraps)
          if (expiry <= now) bootstraps.delete(token);
        while (bootstraps.size >= 8)
          bootstraps.delete(bootstraps.keys().next().value!);
        const token = randomBytes(32).toString("base64url");
        bootstraps.set(token, now + 30 * 60_000);
        try {
          await writeLauncher(stateDir, origin, token);
          launcherToken = token;
        } catch {
          bootstraps.delete(token);
          throw new Error("Launcher unavailable");
        }
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/retire" && method === "POST") {
        const input = (await body(req)) as { token?: unknown };
        if (input.token !== controlToken) {
          error(res, 401, "UNAUTHORIZED", "Open the installer again.");
          return;
        }
        if (jobs.busy) {
          error(
            res,
            409,
            "JOB_RUNNING",
            "Installation is still running. Try again in a moment.",
          );
          return;
        }
        json(res, 200, { ok: true });
        setImmediate(() => void close());
        return;
      }
      if (url.pathname === "/api/session" && method === "POST") {
        const input = (await body(req)) as { token?: unknown };
        if (
          typeof input.token !== "string" ||
          (bootstraps.get(input.token) ?? 0) <= Date.now()
        ) {
          error(res, 401, "UNAUTHORIZED", "Open the installer again.");
          return;
        }
        bootstraps.delete(input.token);
        if (input.token === launcherToken)
          await rm(path.join(stateDir, "launch.html"), { force: true });
        res.setHeader(
          "Set-Cookie",
          `linger_installer_session=${session}; Path=/api; HttpOnly; SameSite=Strict`,
        );
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (
          !(req.headers.cookie ?? "")
            .split(";")
            .some(
              (value) => value.trim() === `linger_installer_session=${session}`,
            )
        ) {
          error(res, 401, "UNAUTHORIZED", "Open the installer again.");
          return;
        }
        if (url.pathname === "/api/setup" && method === "GET") {
          json(res, 200, await dependencies.setup());
          return;
        }
        if (url.pathname === "/api/environment" && method === "GET") {
          json(res, 200, await dependencies.environment());
          return;
        }
        if (url.pathname === "/api/config" && method === "GET") {
          json(
            res,
            200,
            await dependencies.config(
              instanceName(
                url.searchParams.get("instance") ??
                  options.instanceName ??
                  "default",
              ),
            ),
          );
          return;
        }
        if (url.pathname === "/api/instances" && method === "GET") {
          json(res, 200, { items: await dependencies.instances() });
          return;
        }
        const instanceRoute =
          /^\/api\/instances\/([^/]+)\/(status|login|runtime)$/.exec(
            url.pathname,
          );
        if (instanceRoute && method === "GET") {
          const name = instanceName(instanceRoute[1]);
          const result =
            instanceRoute[2] === "status"
              ? await dependencies.status(name)
              : instanceRoute[2] === "runtime"
                ? await dependencies.runtime(name)
                : await dependencies.login(name);
          if (!result) {
            error(
              res,
              404,
              "INSTANCE_NOT_FOUND",
              "Instance or login information not found.",
            );
            return;
          }
          json(res, 200, result);
          return;
        }
        if (url.pathname === "/api/jobs" && method === "GET") {
          json(res, 200, { items: jobs.list() });
          return;
        }
        if (url.pathname === "/api/jobs" && method === "POST") {
          json(res, 202, await jobs.start(validateInput(await body(req))));
          return;
        }
        const jobRoute =
          /^\/api\/jobs\/([a-f0-9-]{36})(?:\/(events|cancel|retry))?$/.exec(
            url.pathname,
          );
        if (jobRoute) {
          const id = jobRoute[1]!,
            action = jobRoute[2];
          if (!jobs.get(id)) {
            error(res, 404, "JOB_NOT_FOUND", "Installation job not found.");
            return;
          }
          if (!action && method === "GET") {
            json(res, 200, jobs.get(id));
            return;
          }
          if (action === "cancel" && method === "POST") {
            json(res, 202, await jobs.cancel(id));
            return;
          }
          if (action === "retry" && method === "POST") {
            json(
              res,
              202,
              await jobs.retry(
                id,
                validateLocalModelsAuthority(await body(req)),
              ),
            );
            return;
          }
          if (action === "events" && method === "GET") {
            const cursor =
              req.headers["last-event-id"] ??
              url.searchParams.get("after") ??
              "0";
            if (typeof cursor !== "string" || !/^\d{1,15}$/.test(cursor))
              throw new Error("Invalid cursor");
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
              "X-Accel-Buffering": "no",
            });
            res.flushHeaders();
            let stopped = false;
            const write = (event: ReturnType<typeof jobs.replay>[number]) => {
              if (stopped) return;
              const frame = `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`;
              if (res.writableLength + Buffer.byteLength(frame) > 256 * 1024) {
                stopped = true;
                res.destroy();
                return;
              }
              res.write(frame);
            };
            const unsubscribe = jobs.subscribe(id, write);
            for (const event of jobs.replay(id, Number(cursor))) write(event);
            const heartbeat = setInterval(() => {
              if (res.writableLength > 256 * 1024) {
                res.destroy();
                return;
              }
              res.write(": heartbeat\n\n");
            }, 15000);
            heartbeat.unref();
            res.once("close", () => {
              stopped = true;
              clearInterval(heartbeat);
              unsubscribe();
            });
            return;
          }
        }
        if (url.pathname === "/api/model/check" && method === "POST") {
          json(res, 200, await checkModel(validateModel(await body(req))));
          return;
        }
        if (url.pathname === "/api/runtime-model/check" && method === "POST") {
          const model = validateModel(await body(req));
          try {
            await checkRuntimeModel(model, AbortSignal.timeout(120000), {
              home: options.home,
            });
            json(res, 200, {
              checks: [
                {
                  id: "runtime-generation",
                  title: "Codex Responses model",
                  state: "ready",
                  detail: "The configured model returned a text response.",
                },
              ],
            });
          } catch {
            json(res, 200, {
              checks: [
                {
                  id: "runtime-generation",
                  title: "Codex Responses model",
                  state: "failed",
                  detail:
                    "Check the Responses-compatible URL, model ID, API key and network, then retry.",
                },
              ],
            });
          }
          return;
        }
        if (url.pathname === "/api/runtime-login" && method === "DELETE") {
          json(
            res,
            200,
            await dependencies.cancelRuntimeLogin(
              instanceName(url.searchParams.get("instance")),
            ),
          );
          return;
        }
        if (
          url.pathname === "/api/runtime-login" &&
          (method === "GET" || method === "POST")
        ) {
          const input =
            method === "POST"
              ? await body(req)
              : { instance: url.searchParams.get("instance") };
          if (
            !input ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            Object.keys(input).some(
              (key) =>
                ![
                  "instance",
                  "code",
                  "apiKey",
                  "provider",
                  "baseUrl",
                  "model",
                ].includes(key),
            )
          )
            throw new Error("Invalid runtime login input");
          const data = input as {
            instance?: unknown;
            code?: unknown;
            apiKey?: unknown;
            provider?: unknown;
            baseUrl?: unknown;
            model?: unknown;
          };
          const name = instanceName(data.instance);
          if (
            data.code !== undefined &&
            (typeof data.code !== "string" ||
              !/^[A-Za-z0-9._~+/#=-]{1,4096}$/.test(data.code))
          )
            throw new Error("Invalid authorization code");
          if (
            (data.apiKey !== undefined || data.provider !== undefined) &&
            (method !== "POST" ||
              data.code !== undefined ||
              typeof data.apiKey !== "string" ||
              !data.apiKey ||
              data.apiKey.length > 4096 ||
              [...data.apiKey].some(
                (character) =>
                  character.charCodeAt(0) <= 32 ||
                  character.charCodeAt(0) === 127,
              ) ||
              !["openai", "anthropic", "openai-compatible"].includes(
                String(data.provider),
              ))
          )
            throw new Error("Invalid runtime credentials");
          if (data.provider === "openai-compatible")
            validateModel({
              baseUrl: data.baseUrl,
              model: data.model,
              apiKey: data.apiKey,
            });
          else if (data.baseUrl !== undefined || data.model !== undefined)
            throw new Error(
              "Model fields require an OpenAI-compatible Pi provider",
            );
          json(
            res,
            200,
            await dependencies.runtimeLogin(
              name,
              method === "POST",
              data.code as string | undefined,
              data.apiKey
                ? {
                    apiKey: data.apiKey as string,
                    provider: data.provider as
                      | "openai"
                      | "anthropic"
                      | "openai-compatible",
                    ...(data.provider === "openai-compatible"
                      ? {
                          baseUrl: data.baseUrl as string,
                          model: data.model as string,
                        }
                      : {}),
                  }
                : undefined,
            ),
          );
          return;
        }
        if (
          [
            "/api/actions/open-data",
            "/api/actions/open-product",
            "/api/actions/stop",
          ].includes(url.pathname) &&
          method === "POST"
        ) {
          const input = (await body(req)) as { instance?: unknown };
          const name = instanceName(input.instance);
          if (url.pathname.endsWith("/stop")) {
            if (jobs.busy) {
              error(
                res,
                409,
                "INSTANCE_BUSY",
                "Wait for the installation step to finish.",
              );
              return;
            }
            if (!(await dependencies.stop(name))) {
              error(res, 404, "INSTANCE_NOT_FOUND", "Instance not found.");
              return;
            }
          } else {
            const target = await dependencies.target(
              name,
              url.pathname.endsWith("open-data") ? "data" : "product",
            );
            if (!target) {
              error(res, 404, "INSTANCE_NOT_FOUND", "Instance not found.");
              return;
            }
            await openLocalTarget(target);
          }
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === "/api/shutdown" && method === "POST") {
          if (jobs.busy) {
            error(
              res,
              409,
              "JOB_RUNNING",
              "Installation is still running. Wait for completion or cancel the job.",
            );
            return;
          }
          json(res, 200, { ok: true });
          setImmediate(() => void close());
          return;
        }
        error(res, 404, "NOT_FOUND", "Action not found.");
        return;
      }
      if (method !== "GET" && method !== "HEAD") {
        error(res, 405, "METHOD_NOT_ALLOWED", "Invalid request method.");
        return;
      }
      const webDir =
        options.webDir ?? fileURLToPath(new URL("./web/", import.meta.url));
      const relative =
        decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      const file = path.resolve(webDir, relative);
      if (!file.startsWith(path.resolve(webDir) + path.sep)) {
        error(res, 404, "NOT_FOUND", "Page not found.");
        return;
      }
      let contents: Buffer;
      try {
        contents = await readFile(file);
      } catch {
        error(res, 404, "NOT_FOUND", "Page not found.");
        return;
      }
      const extension = path.extname(file);
      res.setHeader(
        "Content-Type",
        (
          {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
          } as Record<string, string>
        )[extension] ?? "application/octet-stream",
      );
      res.end(method === "HEAD" ? undefined : contents);
    } catch {
      if (!res.headersSent)
        error(
          res,
          400,
          "INVALID_REQUEST",
          "Invalid request. Check the configuration and environment, then retry.",
        );
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  }).catch((error) => {
    lock.close();
    throw error;
  });
  const address = server.address() as import("node:net").AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  await privateWrite(path.join(stateDir, "session.json"), {
    origin,
    controlToken,
    sourceRepo: options.sourceRepo,
    externalComputer: options.externalComputer ?? false,
    instanceName: options.instanceName ?? "default",
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  async function close() {
    if (closing) return closed;
    closing = true;
    if (idleTimer) clearTimeout(idleTimer);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await jobs.shutdown();
    dependencies.closeRuntimeLogins();
    await rm(path.join(stateDir, "launch.html"), { force: true });
    await rm(path.join(stateDir, "session.json"), { force: true });
    lock.close();
    resolveClosed();
  }
  touch();
  return { origin, bootstrapToken: initialToken, close, closed };
}
