import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from "vite";

import { panelUrlPreviewPlugin } from "./panel-url-preview.mjs";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const defaultAllowedDevHosts = ["127.0.0.1"];

export function resolveAllowedDevHosts(configuredHosts?: string) {
  const configured = configuredHosts
    ? configuredHosts
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean)
    : [];

  return [...new Set([...defaultAllowedDevHosts, ...configured])];
}

export function resolveDevelopmentProxy(
  teamHubBaseUrl: string,
  documentRuntimeUrl: string,
  agentServiceUrl: string,
): Record<string, ProxyOptions> {
  return {
    // X-Forwarded-For lets TeamHub, which trusts loopback proxies, count failed
    // logins per browser instead of per dev server.
    "/v0": {
      changeOrigin: true,
      target: teamHubBaseUrl,
      ws: true,
      xfwd: true,
    },
    // Computers call the Agent CLI API on the Web origin, as on the
    // production host; without this it would answer with the SPA page.
    "/api/agent/": { changeOrigin: true, target: teamHubBaseUrl, xfwd: true },
    "/document-collaboration": {
      changeOrigin: true,
      target: documentRuntimeUrl,
      ws: true,
    },
    // The Agent Service serves the Computer release it ships.
    "/install/": { changeOrigin: true, target: agentServiceUrl },
  };
}

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "");
  const configuredPort = Number(process.env.PORT ?? environment.PORT ?? 3000);
  const teamhubUrl = environment.TEAMHUB_BASE_URL || "http://127.0.0.1:8080";

  return {
    build: {
      chunkSizeWarningLimit: 1_000,
      license: { fileName: "third-party-licenses.md" },
      manifest: command === "build",
    },
    envDir: repositoryRoot,
    optimizeDeps: {
      include: [
        "ajv-draft-04",
        "@blocknote/core",
        "@blocknote/core/comments",
        "@blocknote/core/extensions",
        "@blocknote/core/yjs",
        "@blocknote/mantine",
        "@blocknote/react",
        "@hocuspocus/provider",
        "yjs",
      ],
    },
    plugins: [react(), developmentHealthPlugin(), panelUrlPreviewPlugin()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    root: appRoot,
    server: {
      allowedHosts: resolveAllowedDevHosts(environment.WEB_ALLOWED_DEV_HOSTS),
      headers:
        mode === "development" ? { "Cache-Control": "no-cache" } : undefined,
      // Sandboxed Office modules use an opaque origin, including shared Vite imports.
      cors: true,
      host: "127.0.0.1",
      port: Number.isInteger(configuredPort) ? configuredPort : 3000,
      proxy: resolveDevelopmentProxy(
        teamhubUrl,
        environment.TEAMHUB_DOCUMENT_RUNTIME_URL || "http://127.0.0.1:4321",
        environment.TEAMHUB_NODE_SERVICES_URL || "http://127.0.0.1:4319",
      ),
      strictPort: true,
    },
    worker: {
      format: "es",
      plugins: () => {
        let officeFormat: string | undefined;
        return [
          oneWorkerBuildAtATime(),
          {
            name: "office-preview-single-bundle",
            options(options) {
              const inputs =
                typeof options.input === "string"
                  ? [options.input]
                  : Object.values(options.input ?? {});
              officeFormat =
                inputs.length === 1
                  ? /^(.+)\/src\/features\/rooms\/files\/office-preview-frame-(docx?|pptx?|xlsx?)\.ts$/.exec(
                      inputs[0] ?? "",
                    )?.[2]
                  : undefined;
            },
            transform(code, id) {
              if (
                !officeFormat ||
                !id.endsWith(
                  "/node_modules/@open-file-viewer/core/dist/index.js",
                )
              )
                return;
              // core 0.1.36 exposes one Office plugin, not per-format exports.
              // Preflight already enforces the declared format. Prune only its
              // unused parser imports; retain the viewer, layout and fallbacks.
              const parsers: Record<string, string[]> = {
                "@aiden0z/pptx-renderer": ["pptx"],
                mammoth: ["docx"],
                xlsx: ["xls", "xlsx", "ppt"], // Legacy PPT uses its CFB reader.
                "emf-converter": ["ppt"],
                "pdfjs-dist": [], // officePlugin() has no PDF conversion callback.
              };
              for (const [parser, formats] of Object.entries(parsers)) {
                const expression = `import(${JSON.stringify(parser)})`;
                if (!code.includes(expression))
                  this.error(`Office parser import changed: ${parser}`);
                if (!formats.includes(officeFormat)) {
                  code = code.replaceAll(
                    expression,
                    `Promise.reject(new Error("Parser unavailable for this Office format"))`,
                  );
                }
              }
              const docxImport = 'import * as docxPreview from "docx-preview";';
              if (!code.includes(docxImport))
                this.error("Office DOCX parser import changed");
              if (officeFormat !== "docx") {
                code = code.replace(
                  docxImport,
                  'const docxPreview = { renderAsync() { throw new Error("DOCX parser unavailable for this Office format"); } };',
                );
              }
              return { code, map: null };
            },
            outputOptions(options) {
              // The parent caches this code for a nonce-protected srcdoc script.
              // That script cannot fetch late imports from its opaque origin.
              if (officeFormat) return { ...options, codeSplitting: false };
            },
          },
        ];
      },
    },
  };
});

// Vite bundles every `?worker` import at once, each in its own Rolldown build.
// The six Office preview frames each inline the viewer and its parsers, so
// together they took about 3 GB more than the app itself. One at a time keeps
// the peak near a single build's.
let workerBuilds: Promise<void> = Promise.resolve();

export function oneWorkerBuildAtATime(): Plugin {
  let release: (() => void) | undefined;
  const done = () => {
    release?.();
    release = undefined;
  };
  return {
    name: "one-worker-build-at-a-time",
    async buildStart() {
      const previous = workerBuilds;
      workerBuilds = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
    },
    // A failed build may never reach closeBundle.
    buildEnd(error) {
      if (error) done();
    },
    closeBundle: done,
  };
}

export function developmentHealthPlugin(): Plugin {
  return {
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost")
          .pathname;
        if (
          pathname !== "/healthz" ||
          (request.method !== "GET" && request.method !== "HEAD")
        ) {
          next();
          return;
        }

        const body = JSON.stringify({
          ok: true,
          service: "linger-web-dev",
        });

        response.statusCode = 200;
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(request.method === "HEAD" ? undefined : body);
      });
    },
    name: "linger-development-health",
  };
}
