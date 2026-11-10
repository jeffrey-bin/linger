import { createServer } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export async function loadWebDevelopmentEnvironment() {
  const requireFromWeb = createRequire(
    path.join(repositoryRoot, "apps/web/package.json"),
  );
  const viteEntry = requireFromWeb.resolve("vite");
  const { loadEnv } = await import(pathToFileURL(viteEntry).href);
  return loadEnv("development", repositoryRoot, "");
}

export async function ensureWebDevelopmentPortAvailable(
  port,
  host = "127.0.0.1",
) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error && typeof error === "object" && error.code === "EADDRINUSE") {
        reject(
          new Error(
            `${host}:${port} is already in use; stop that listener or set PORT to another value.`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen({ exclusive: true, host, port }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

export async function prepareWebDevelopment({
  environment = process.env,
  loadDevelopmentEnvironment = loadWebDevelopmentEnvironment,
} = {}) {
  const developmentEnvironment = await loadDevelopmentEnvironment();
  const configuredPort = Number(
    environment.PORT ?? developmentEnvironment.PORT ?? 3000,
  );
  if (
    !Number.isInteger(configuredPort) ||
    configuredPort < 0 ||
    configuredPort > 65535
  ) {
    throw new Error(`PORT must be an integer from 0 through 65535.`);
  }
  await ensureWebDevelopmentPortAvailable(configuredPort);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await prepareWebDevelopment();
}
