import http from "node:http";
import { parseArgs } from "node:util";
import { serviceCredential } from "@linger/service-kit/node";
import {
  NODE_SERVICES_DEFAULT_ADDRESS,
  readListenAddress,
} from "../listen-address.js";
import { isMainModule } from "../paths.js";

const USAGE =
  "Usage: rebuild-cli start (--owner <actor_id> | --subject <memory_subject_key>) [--from YYYY-MM-DD] [--restart]\n" +
  "       rebuild-cli status (--owner <actor_id> | --subject <memory_subject_key>)";

/** Maps operator arguments to the local Memory rebuild API request. */
export function rebuildRequest(argv: string[]): {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
} {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      owner: { type: "string" },
      subject: { type: "string" },
      from: { type: "string" },
      restart: { type: "boolean" },
    },
  });
  if (!values.owner === !values.subject) throw new Error(USAGE);
  const target: Record<string, string> = values.owner
    ? { owner_actor_id: values.owner }
    : { memory_subject_key: values.subject! };
  if (command === "status" && !values.from && !values.restart)
    return {
      method: "GET",
      path: `/internal/v1/rebuild?${new URLSearchParams(target)}`,
    };
  if (command !== "start") throw new Error(USAGE);
  return {
    method: "POST",
    path: "/internal/v1/rebuild",
    body: {
      ...target,
      ...(values.from ? { from: values.from } : {}),
      ...(values.restart ? { restart: true } : {}),
    },
  };
}

// node:http has no response deadline; admission waits for the step in flight.
function send(
  request: ReturnType<typeof rebuildRequest>,
  environment: NodeJS.ProcessEnv,
): Promise<{ status: number; body: string }> {
  const token = serviceCredential("node-services-internal", environment);
  if (!token) throw new Error("LINGER_SECRET_SEED is required");
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        // The listener of this host's Node Services, whatever interface it binds.
        host: "127.0.0.1",
        port: readListenAddress(
          environment,
          "NODE_SERVICES_HTTP_ADDRESS",
          NODE_SERVICES_DEFAULT_ADDRESS,
        ).port,
        method: request.method,
        path: request.path,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(request.body ? JSON.stringify(request.body) : undefined);
  });
}

export async function main(
  argv = process.argv.slice(2),
  environment = process.env,
): Promise<void> {
  const response = await send(rebuildRequest(argv), environment);
  process.stdout.write(`${response.body}\n`);
  if (response.status < 200 || response.status >= 300) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
