import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv, promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

const repositoryRoot = new URL("../", import.meta.url);
const execFileAsync = promisify(execFile);

async function readRepositoryFile(path: string): Promise<string> {
  return readFile(new URL(path, repositoryRoot), "utf8");
}

async function createPnpmPolicyFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pnpm-worktree-policy-"));
  const policy = parse(await readRepositoryFile("pnpm-workspace.yaml"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:npm|pnpm)_config_/i.test(key) && key !== "CI",
    ),
  );
  Object.assign(env, {
    HOME: path.join(root, "home"),
    PNPM_HOME: path.join(root, "shared-pnpm"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_DATA_HOME: path.join(root, "data"),
    PNPM_CONFIG_OFFLINE: "true",
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: "false",
  });
  const workspace = stringify({
    packages: [],
    storeDir: policy.storeDir,
    verifyDepsBeforeRun: policy.verifyDepsBeforeRun,
  });
  const packageManager = JSON.parse(
    await readRepositoryFile("package.json"),
  ).packageManager;
  for (const name of ["a", "b"]) {
    const directory = path.join(root, name);
    await mkdir(directory);
    await writeFile(path.join(directory, "pnpm-workspace.yaml"), workspace);
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ private: true, packageManager }),
    );
  }
  return { root, env, packageManager };
}

describe("active product development commands", () => {
  it("shares pnpm package storage across worktrees and respects a CI override", async () => {
    const { root, env } = await createPnpmPolicyFixture();
    try {
      const stores = await Promise.all(
        ["a", "b"].map(async (name) => {
          const { stdout } = await execFileAsync("pnpm", ["store", "path"], {
            cwd: path.join(root, name),
            env,
          });
          return stdout.trim();
        }),
      );
      expect(stores[0]).toBe(stores[1]);
      expect(stores[0]).toContain("shared-pnpm");
      const ciStore = path.join(root, "ci-store");
      const { stdout } = await execFileAsync("pnpm", ["store", "path"], {
        cwd: path.join(root, "a"),
        env: { ...env, PNPM_CONFIG_STORE_DIR: ciStore },
      });
      expect(stdout.trim()).toContain("ci-store");
      expect(stdout.trim()).not.toBe(stores[0]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing pnpm dependencies without installing or starting scripts", async () => {
    const { root, env, packageManager } = await createPnpmPolicyFixture();
    const directory = path.join(root, "a");
    try {
      await mkdir(path.join(directory, "dependency"));
      await writeFile(
        path.join(directory, "dependency", "package.json"),
        JSON.stringify({ name: "local-dependency", version: "1.0.0" }),
      );
      await writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({
          private: true,
          packageManager,
          dependencies: { "local-dependency": "file:./dependency" },
          scripts: {
            probe:
              "node -e \"require('node:fs').writeFileSync('probe-ran', '')\"",
            preinstall:
              "node -e \"require('node:fs').writeFileSync('install-ran', '')\"",
          },
        }),
      );
      const result = await execFileAsync("pnpm", ["run", "probe"], {
        cwd: directory,
        env,
      }).catch(
        (error: { code: number; stdout: string; stderr: string }) => error,
      );
      expect(result).toMatchObject({ code: 1 });
      expect(result.stdout + result.stderr).toContain("VERIFY_DEPS_BEFORE_RUN");
      for (const name of [
        "probe-ran",
        "install-ran",
        "pnpm-lock.yaml",
        "node_modules",
      ]) {
        await expect(access(path.join(directory, name))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails fast instead of auto-installing a mismatched pnpm version", async () => {
    const npmConfig = await readRepositoryFile(".npmrc");

    expect(npmConfig).toMatch(/^pm-on-fail=error$/m);
    expect(npmConfig).toMatch(/^manage-package-manager-versions=false$/m);
    expect(npmConfig).toMatch(/^package-manager-strict-version=true$/m);
  });

  it("copies pnpm patches before every Node image install", async () => {
    const dockerignore = await readRepositoryFile(".dockerignore");
    expect(dockerignore).toMatch(/^!patches$/m);
    expect(dockerignore).toMatch(/^!patches\/\*\*$/m);
    expect(dockerignore).toMatch(/^\*\*\/\.local$/m);

    for (const path of [
      "apps/web/Dockerfile",
      "apps/node-services/Dockerfile",
    ]) {
      const dockerfile = await readRepositoryFile(path);
      const patchCopy = dockerfile.indexOf("COPY patches ./patches");
      const dependencyInstall = [
        dockerfile.indexOf("pnpm install", patchCopy),
        dockerfile.indexOf("pnpm --config.inject", patchCopy),
      ].find((position) => position >= 0);

      expect(patchCopy, path).toBeGreaterThan(-1);
      expect(dependencyInstall, path).toBeGreaterThan(patchCopy);
    }

    const nodeServicesDockerfile = await readRepositoryFile(
      "apps/node-services/Dockerfile",
    );
    // One for the node-services install, one for the Computer release install.
    expect(
      nodeServicesDockerfile.match(/COPY patches \.\/patches/g),
    ).toHaveLength(2);
  });

  it("pins the Node runtime across local development and images", async () => {
    const version = (await readRepositoryFile(".node-version")).trim();
    const packageJson = JSON.parse(
      await readRepositoryFile("package.json"),
    ) as { engines: { node: string } };
    const nodeServicesPackageJson = JSON.parse(
      await readRepositoryFile("apps/node-services/package.json"),
    ) as {
      engines: { node: string };
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const webDockerfile = await readRepositoryFile("apps/web/Dockerfile");
    const nodeServicesDockerfile = await readRepositoryFile(
      "apps/node-services/Dockerfile",
    );

    expect(version).toBe("26.5.0");
    expect(packageJson.engines.node).toBe(">=26.5.0 <27");
    expect(nodeServicesPackageJson.engines.node).toBe(">=26.5.0 <27");
    expect(nodeServicesPackageJson.devDependencies["@types/node"]).toBe(
      "26.0.1",
    );
    expect(nodeServicesPackageJson.dependencies).not.toHaveProperty(
      "@openai/codex",
    );
    expect(nodeServicesPackageJson.devDependencies).not.toHaveProperty(
      "@openai/codex",
    );
    expect(webDockerfile).toContain("FROM node:26.5.0-bookworm-slim@sha256:");
    expect(nodeServicesDockerfile).toContain(
      "ARG NODE_IMAGE=node:26.5.0-bookworm-slim@sha256:",
    );
  });

  it("builds every role from one non-root node-services image", async () => {
    const dockerfile = await readRepositoryFile(
      "apps/node-services/Dockerfile",
    );
    const makefile = await readRepositoryFile("Makefile");
    const manifestStage = dockerfile.slice(
      dockerfile.indexOf("AS dependency-manifests"),
      dockerfile.indexOf("AS dependencies"),
    );
    const runtimeStage = dockerfile.slice(
      dockerfile.indexOf("FROM ${NODE_IMAGE} AS node-services"),
    );

    expect(manifestStage).toMatch(
      /apt-get install --yes --no-install-recommends python3 make g\+\+/,
    );
    expect(manifestStage).toContain("ENV npm_config_nodedir=/usr/local");
    expect(manifestStage).toContain(
      "COPY packages/knowledge-format/package.json ./packages/knowledge-format/package.json",
    );
    expect(manifestStage).toContain(
      "COPY packages/service-kit/package.json ./packages/service-kit/package.json",
    );
    expect(dockerfile).toContain("--prod --frozen-lockfile");
    expect(runtimeStage).not.toMatch(/python3|\bmake\b|g\+\+/);
    expect(runtimeStage).not.toMatch(/\bgit\b/);
    expect(runtimeStage).toContain("USER node");
    expect(runtimeStage).toContain(
      'CMD ["node", "--conditions=linger-production", "apps/node-services/dist/main.js"]',
    );
    expect(runtimeStage).toContain(
      "COPY apps/node-services/prompts ./apps/node-services/prompts",
    );
    // knowledge-format resolves its runtime dependency (yaml) from its own node_modules, so the image must carry it.
    expect(runtimeStage).toContain(
      "COPY --from=production-dependencies /app/packages/knowledge-format/node_modules ./packages/knowledge-format/node_modules",
    );
    expect(dockerfile).not.toContain("AGENT_RUNTIME_BASE");
    // One image runs every role; no per-role targets remain.
    expect(dockerfile).not.toContain("NODE_SERVICES_ROLES");
    // Six node-services stages plus three Computer release stages.
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(9);
    expect(runtimeStage).toContain(
      "ENV NODE_SERVICES_HTTP_ADDRESS=0.0.0.0:4319",
    );
    expect(runtimeStage).toContain("EXPOSE 4319 4321");
    // The Agent role needs its workspace packages in the production image.
    expect(runtimeStage).toContain(
      "COPY --from=build /app/packages/document-files/dist ./packages/document-files/dist",
    );
    expect(runtimeStage).toContain(
      "await import('./apps/node-services/dist/agent/main.js')",
    );
    expect(makefile).toContain(
      "docker buildx build --check -f apps/node-services/Dockerfile .",
    );
  });

  it("packages the offline normalizer into node-services", async () => {
    const manifest = JSON.parse(
      await readRepositoryFile("apps/node-services/package.json"),
    );
    for (const name of [
      "tesseract.js-core",
      "@tesseract.js-data/eng",
      "@tesseract.js-data/chi_sim",
      "@napi-rs/canvas",
      "sharp",
    ]) {
      expect(manifest.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
    const dockerfile = await readRepositoryFile(
      "apps/node-services/Dockerfile",
    );
    for (const line of [
      "COPY apps/node-services/src ./apps/node-services/src",
      "COPY --from=build /app/apps/node-services/dist ./apps/node-services/dist",
      "COPY --from=production-dependencies /app/apps/node-services/node_modules ./apps/node-services/node_modules",
    ]) {
      expect(dockerfile).toContain(line);
    }
  });

  it("keeps role dependencies inside the node-services package", async () => {
    const rootPackage = JSON.parse(
      await readRepositoryFile("package.json"),
    ) as {
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const nodeServicesPackage = JSON.parse(
      await readRepositoryFile("apps/node-services/package.json"),
    ) as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const dockerfile = await readRepositoryFile(
      "apps/node-services/Dockerfile",
    );

    expect(nodeServicesPackage.name).toBe("@linger/node-services");
    expect(nodeServicesPackage.dependencies).toEqual({
      "@hocuspocus/server": "^4.3.0",
      "@hono/node-server": "^1.19.14",
      "@napi-rs/canvas": "1.0.5",
      "@linger/document-files": "workspace:*",
      "@linger/document-model": "workspace:*",
      "@linger/knowledge-format": "workspace:*",
      "@linger/service-kit": "workspace:*",
      "@linger/voice-runtime": "workspace:*",
      "@tesseract.js-data/chi_sim": "1.0.0",
      "@tesseract.js-data/eng": "1.0.0",
      "@linger/wire-contracts": "workspace:*",
      ajv: "8.17.1",
      hono: "^4.12.31",
      jszip: "3.10.1",
      mailparser: "3.10.0",
      officeparser: "8.2.0",
      jsdom: "29.1.1",
      "pdfjs-dist": "6.2.108",
      openwiki: "0.4.3",
      postgres: "3.4.9",
      sharp: "0.35.3",
      "tesseract.js-core": "7.0.0",
      "proper-lockfile": "^4.1.2",
      "word-extractor": "1.0.4",
      undici: "8.10.0",
      xlsx: "npm:@e965/xlsx@0.20.3",
      ws: "8.22.0",
      yaml: "2.9.0",
      yjs: "13.6.31",
    });
    expect(nodeServicesPackage.devDependencies).toEqual({
      "@hocuspocus/provider": "^4.3.0",
      "@modelcontextprotocol/sdk": "^1.29.0",
      "@linger/teamhub-cli": "workspace:*",
      "@types/mailparser": "3.9.0",
      "@types/jsdom": "^21.1.7",
      "@types/node": "26.0.1",
      "@types/proper-lockfile": "^4.1.4",
      "@types/ws": "8.18.2",
      "@types/yauzl": "3.4.0",
      "@types/yazl": "3.3.1",
      tsx: "4.22.4",
      typescript: "6.0.3",
      vitest: "4.1.9",
      yauzl: "3.4.0",
      yazl: "3.3.1",
    });
    expect(rootPackage.dependencies).toBeUndefined();
    expect(rootPackage.scripts["llm-wiki"]).toBeUndefined();
    expect(dockerfile).toContain(
      "COPY apps/node-services/package.json ./apps/node-services/package.json",
    );
    expect(dockerfile).toContain(
      "pnpm install --filter @linger/node-services... --frozen-lockfile",
    );
    expect(dockerfile).not.toContain("--filter linger");
  });

  it("installs image dependencies from the root lockfile before application source", async () => {
    const dockerfiles = {
      web: await readRepositoryFile("apps/web/Dockerfile"),
      "node-services": await readRepositoryFile(
        "apps/node-services/Dockerfile",
      ),
    };
    const dockerignore = await readRepositoryFile(".dockerignore");

    expect(dockerignore).toContain("!pnpm-lock.yaml");
    expect(dockerignore).toContain("!apps/**");

    const webInstall = dockerfiles.web.indexOf(
      "pnpm install --filter @linger/web...",
    );
    expect(dockerfiles.web.indexOf("COPY apps/web/package.json")).toBeLessThan(
      webInstall,
    );
    expect(dockerfiles.web.indexOf("COPY apps/web ./apps/web")).toBeGreaterThan(
      webInstall,
    );

    for (const [service, dockerfile] of Object.entries(dockerfiles)) {
      expect(dockerfile).toContain(
        "ARG NPM_REGISTRY=https://registry.npmjs.org",
      );
      expect(dockerfile).toContain(
        "npm config set @openai:registry https://registry.npmjs.org --location=user",
      );
      expect(dockerfile).toContain(
        "COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./",
      );
      expect(dockerfile).toContain(
        `id=pnpm-store-${service}-node26.5.0-pnpm11.7.0-linux-amd64,sharing=locked`,
      );
      expect(dockerfile).toContain("--frozen-lockfile --trust-lockfile");
    }
    expect(dockerfiles.web).not.toContain(
      "apps/node-services/release-lockfiles/",
    );
    // Only the bundled Computer release keeps its pruned lockfile.
    expect(
      new Set(
        dockerfiles["node-services"].match(
          /apps\/node-services\/release-lockfiles\/[\w.-]+/g,
        ),
      ),
    ).toEqual(
      new Set([
        "apps/node-services/release-lockfiles/computer.yaml",
        "apps/node-services/release-lockfiles/package.json",
      ]),
    );
  });

  it("serves the Computer release from the Agent Service, not the Web image", async () => {
    const compose = await readRepositoryFile("docker-compose.yml");
    expect(compose).not.toContain("LINGER_COMPUTER_RELEASE_BASE_URL");
    expect(compose).toContain(
      "TEAMHUB_NODE_SERVICES_URL: http://node-services:4319",
    );
    const dockerfile = await readRepositoryFile("apps/web/Dockerfile");
    expect(dockerfile).not.toMatch(/WEB_PUBLIC_ORIGIN|public\/install/);
    const nodeServices = await readRepositoryFile(
      "apps/node-services/Dockerfile",
    );
    const runtimeStage = nodeServices.split(" AS node-services")[1]!;
    // Dependency archives come first so their layer survives code changes.
    expect(
      runtimeStage.indexOf(
        "COPY --link --from=computer-deps /out/files/ /app/computer-release/files/",
      ),
    ).toBeLessThan(runtimeStage.indexOf("COPY --from=production-dependencies"));
    expect(runtimeStage).toContain(
      "COPY --from=computer-app /out/ /app/computer-release/",
    );
  });

  it("opens the TeamHub image listener and derives the preview origin from it", async () => {
    const dockerfile = await readRepositoryFile("apps/teamhub/Dockerfile");
    const runtimeStage = dockerfile.split("FROM runtime-base AS runtime")[1];

    expect(runtimeStage).toContain("ENV TEAMHUB_HTTP_ADDRESS=:8080");
    expect(runtimeStage).not.toContain(
      "TEAMHUB_DOCUMENT_PREVIEW_PUBLIC_ORIGIN",
    );
  });

  it("keeps release dependency downloads behind dependency-only cache layers", async () => {
    const teamhubDockerfile = await readRepositoryFile(
      "apps/teamhub/Dockerfile",
    );
    const moduleManifest = teamhubDockerfile.indexOf(
      "COPY apps/teamhub/go.mod apps/teamhub/go.sum ./",
    );
    const moduleDownload = teamhubDockerfile.indexOf("go mod download");
    const contractsModuleManifest = teamhubDockerfile.indexOf(
      "COPY contracts/generated/go/go.mod /src/contracts/generated/go/go.mod",
    );
    const skillsModuleManifest = teamhubDockerfile.indexOf(
      "COPY skills/go.mod /src/skills/go.mod",
    );

    expect(contractsModuleManifest).toBeGreaterThan(-1);
    expect(skillsModuleManifest).toBeGreaterThan(-1);
    expect(moduleDownload).toBeGreaterThan(moduleManifest);
    expect(moduleDownload).toBeGreaterThan(contractsModuleManifest);
    expect(moduleDownload).toBeGreaterThan(skillsModuleManifest);
    expect(
      teamhubDockerfile.indexOf(
        "COPY contracts/generated/go /src/contracts/generated/go",
      ),
    ).toBeGreaterThan(moduleDownload);
    expect(
      teamhubDockerfile.indexOf("COPY skills /src/skills"),
    ).toBeGreaterThan(moduleDownload);
  });

  it("starts host development from a pre-provisioned root environment", async () => {
    const packageJson = JSON.parse(
      await readRepositoryFile("package.json"),
    ) as { scripts: Record<string, string> };
    const nodeServicesPackageJson = JSON.parse(
      await readRepositoryFile("apps/node-services/package.json"),
    ) as { scripts: Record<string, string> };
    const rootCompose = await readRepositoryFile("docker-compose.yml");
    const teamhubMakefile = await readRepositoryFile("apps/teamhub/Makefile");
    const preCommit = await readRepositoryFile(".husky/pre-commit");
    const scripts = packageJson.scripts;

    expect(scripts.dev).toContain("dev:prepare");
    expect(scripts.dev).toContain("concurrently");
    expect(scripts.dev).toContain("dev:web");
    expect(scripts.dev).toContain("dev:teamhub:watch");
    expect(scripts.dev).not.toContain("dev:agent");
    expect(scripts.dev).not.toContain("document-runtime");
    expect(scripts.dev).toContain("--names web,teamhub,node-services,livekit");
    expect(scripts["dev:livekit"]).toBe(
      "node scripts/with-local-env.mjs -- node --import tsx scripts/dev-livekit.ts",
    );
    expect(scripts["dev:agent"]).toBeUndefined();
    expect(scripts["dev:node-services"]).toBe(
      "node scripts/with-local-env.mjs -- pnpm --filter @linger/node-services start",
    );
    // pnpm dev supervises the merged process: it waits for TeamHub and
    // restarts after a crash, without watching files.
    expect(nodeServicesPackageJson.scripts.start).toBe(
      "node ../../scripts/with-local-env.mjs -- node --import tsx scripts/dev-supervisor.ts",
    );
    expect(nodeServicesPackageJson.scripts.start).not.toContain("--watch");
    expect(nodeServicesPackageJson.scripts.dev).toContain("--watch");
    expect(scripts["dev:web"]).toContain("scripts/wait-for-http-services.ts");
    expect(scripts["dev:web"]).toContain(
      'teamhub="${TEAMHUB_BASE_URL:-http://127.0.0.1:8080}"',
    );
    expect(scripts["dev:web"]).toContain("${teamhub%/}/healthz");
    expect(
      scripts["dev:web"].indexOf("wait-for-http-services.ts"),
    ).toBeLessThan(scripts["dev:web"].indexOf("pnpm --filter @linger/web dev"));
    expect(scripts["dev:check"]).not.toContain(":4320/");
    expect(scripts["dev:check"]).not.toContain(":4323/");
    expect(preCommit).toContain("pnpm lint:staged");
    expect(scripts["dev:prepare"]).toContain("dev-migrate");
    expect(scripts["dev:prepare"]).not.toContain("personal-cloud");
    expect(scripts["local:config:prepare"]).toBeUndefined();
    expect(scripts["local:config:sync"]).toBeUndefined();
    expect(scripts["dev:teamhub"]).toContain("make -C apps/teamhub dev");
    // pnpm dev runs no containers: the developer runs PostgreSQL, and
    // LiveKit when they want it. Compose is the other way to start.
    expect(
      Object.keys(scripts).filter((name) => name.startsWith("dev:voice")),
    ).toEqual([]);
    expect(scripts["dev:infra:up"]).toBeUndefined();
    expect(teamhubMakefile).not.toMatch(/^dev-migrate:.*db-up/m);
    expect(teamhubMakefile).not.toContain("docker compose");
    expect(rootCompose).toContain("livekit:");
    expect(rootCompose).toContain("LIVEKIT_URL: ws://livekit:7880");
    expect(rootCompose).toContain("LIVEKIT_API_URL: http://livekit:7880");
    expect(scripts["stack:up"]).toContain("docker compose up");
    expect(scripts["stack:up"]).not.toContain("local:config");
    expect(scripts["dev:check"]).toContain("localhost:3000/healthz");
    expect(scripts["dev:check"]).toContain("localhost:8080/healthz");
    expect(scripts["dev:check"]).toContain("localhost:4319/healthz");
    expect(scripts["dev:check"]).toContain("localhost:4319/readyz");
    expect(scripts["dev:check"]).toContain("localhost:4321/healthz");
    expect(scripts["dev:check"]).toContain("localhost:4321/readyz");
    expect(scripts["stack:logs"]).toContain("docker compose logs");
    expect(scripts["stack:down"]).toContain("docker compose down");
    expect(scripts["dev:stack"]).toBeUndefined();
    expect(scripts["dev:stack:down"]).toBeUndefined();
  });

  it("checks only live service URLs and launches Web after TeamHub readiness", async () => {
    const { scripts } = JSON.parse(
      await readRepositoryFile("package.json"),
    ) as { scripts: Record<string, string> };
    for (const name of ["dev:web", "dev:check"]) {
      const { stdout } = await execFileAsync(
        "/bin/sh",
        [
          "-c",
          `
node() { printf 'node %s\\n' "$*"; }
pnpm() { printf 'pnpm %s\\n' "$*"; }
curl() { for arg do case "$arg" in http://*|https://*) printf 'curl %s\\n' "$arg"; return 0;; esac; done; return 64; }
${scripts[name].replace(/^node scripts\/with-local-env\.mjs -- sh -c '(.*)'$/s, "$1")}`,
        ],
        {
          env: {
            PATH: process.env.PATH,
            LOCAL_ENV_FILE: "/dev/null",
            TEAMHUB_BASE_URL: "http://teamhub.test:8080/",
          },
        },
      );
      if (name.startsWith("dev:web")) {
        expect(stdout.trim().split("\n")[0]).toBe(
          "node --import tsx scripts/wait-for-http-services.ts http://teamhub.test:8080/healthz",
        );
        expect(stdout).toContain("pnpm --filter @linger/web");
      } else {
        expect(stdout).toContain("curl http://localhost:8080/healthz");
        expect(stdout).not.toContain(":4324/");
      }
    }
  });

  it("fails before infrastructure startup when the configured environment file is missing", async () => {
    let failure: unknown;
    try {
      await execFileAsync("pnpm", ["dev:prepare"], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          LOCAL_ENV_FILE: ".missing-development-environment",
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      stderr: expect.stringContaining("Missing local environment file"),
    });
    expect((failure as { stdout: string }).stdout).not.toContain(
      "docker compose",
    );
  });

  it("keeps an inherited Codex home when loading the local environment template", async () => {
    const result = await execFileAsync(
      "bash",
      [
        "-c",
        'source "$1"; printf "%s" "$CODEX_HOME"',
        "bash",
        path.join(repositoryRoot.pathname, "scripts/local-defaults.env"),
      ],
      { env: { ...process.env, CODEX_HOME: "/fixture/preset-codex" } },
    );
    expect(result.stdout).toBe("/fixture/preset-codex");
  });

  it("ships a safe and internally consistent local environment template", async () => {
    const template = parseEnv(await readRepositoryFile(".env.example"));
    const defaults = parseEnv(
      await readRepositoryFile("scripts/local-defaults.env"),
    );
    const environment = { ...defaults, ...template };
    const compose = await readRepositoryFile("docker-compose.yml");
    // The template turns on every feature that needs no personal key: each
    // entry holds the value `pnpm dev` uses, so it never contradicts the
    // fixed local defaults, and only personal keys stay empty.
    for (const [name, value] of Object.entries(defaults))
      expect(template[name], name).toBe(value);
    expect(
      Object.keys(template)
        .filter((name) => template[name] === "")
        .sort(),
    ).toEqual(["COMPOSIO_API_KEY", "SONIOX_API_KEY", "XAI_API_KEY"]);
    // Fixed local settings live in the defaults file the launcher loads first.
    expect(Object.keys(defaults).sort()).toEqual([
      "AGENT_HOME",
      "AGENT_RUNNER_PUBLIC_GATEWAY_URL",
      "COMPUTER_RELEASE_DIR",
      "LINGER_SECRET_SEED",
      "TEAMHUB_DATABASE_URL",
      "TEAMHUB_SECRET_ENCRYPTION_KEY",
      "TEAMHUB_TRUSTED_PROXIES",
      "WEB_PUBLIC_ORIGIN",
    ]);
    // Settings that differ per host or would break builds stay commented out,
    // and so do values derived from another entry: each service has one URL,
    // and its listener defaults to loopback at that URL's port.
    for (const name of [
      "COMPOSE_PROJECT_NAME",
      "COMPUTER_RELEASE_TARGETS",
      "NODE_ENV",
      "TEAMHUB_HTTP_ADDRESS",
      "NODE_SERVICES_HTTP_ADDRESS",
      "DOCUMENT_RUNTIME_HTTP_ADDRESS",
      "TEAMHUB_DOCUMENT_PREVIEW_PUBLIC_ORIGIN",
      "TEAMHUB_CLI_BASE_URL",
      "AGENT_SERVICE_URL",
    ])
      expect(template[name], name).toBeUndefined();
    // Compose loads the same defaults and keeps container values explicit.
    for (const value of [
      'TEAMHUB_HTTP_ADDRESS: ":8080"',
      'NODE_SERVICES_HTTP_ADDRESS: "0.0.0.0:4319"',
      'DOCUMENT_RUNTIME_HTTP_ADDRESS: "0.0.0.0:4321"',
      'TEAMHUB_CLI_BASE_URL: "${TEAMHUB_CLI_BASE_URL:-${WEB_PUBLIC_ORIGIN:-http://localhost:3000}}"',
      "AGENT_HOME: /data/agent/mirror",
    ])
      expect(compose).toContain(value);
    // Single-host service addresses match the code defaults.
    expect(environment.TEAMHUB_BASE_URL).toBe("http://127.0.0.1:8080");
    expect(environment.TEAMHUB_NODE_SERVICES_URL).toBe("http://127.0.0.1:4319");
    expect(environment.TEAMHUB_DOCUMENT_RUNTIME_URL).toBe(
      "http://127.0.0.1:4321",
    );
    expect(environment.WEB_PUBLIC_ORIGIN).toBe("http://localhost:3000");
    expect(compose).toContain(
      'WEB_PUBLIC_ORIGIN: "${WEB_PUBLIC_ORIGIN:-http://localhost:3000}"',
    );
    expect(environment.CODEX_HOME).toBeUndefined();
    // Service credentials derive only from one seed; no overrides.
    expect(environment.LINGER_SECRET_SEED?.length).toBeGreaterThanOrEqual(32);
    for (const name of [
      "TEAMHUB_AGENT_SERVICE_TOKEN",
      "TEAMHUB_AGENT_RUN_TOKEN_SECRET",
      "TEAMHUB_DOCUMENT_RUNTIME_TOKEN",
      "DOCUMENT_RUNTIME_TEAMHUB_STATE_TOKEN",
      "MEMORY_SERVICE_TOKEN",
    ])
      expect(environment[name], name).toBeUndefined();
    // Voice waits only for SONIOX_API_KEY or XAI_API_KEY; LiveKit points at
    // the local server.
    expect(environment.SONIOX_API_KEY).toBe("");
    expect(environment.XAI_API_KEY).toBe("");
    expect(environment.LIVEKIT_URL).toBe("ws://127.0.0.1:17880");
  });

  it("ships every Node role as one compose process with the Document port kept apart", async () => {
    const compose = await readRepositoryFile("docker-compose.yml");

    expect(compose).toContain("  node-services:");
    expect(compose).toContain("dockerfile: apps/node-services/Dockerfile");
    for (const retired of ["  agent:", "  memory:", "  document-runtime:"])
      expect(compose).not.toContain(retired);
    expect(compose).toContain("TEAMHUB_BASE_URL: http://teamhub:8080");
    expect(compose).toContain(
      "TEAMHUB_NODE_SERVICES_URL: http://node-services:4319",
    );
    expect(compose).toContain(
      "TEAMHUB_DOCUMENT_RUNTIME_URL: http://node-services:4321",
    );
    expect(compose).toContain(
      '"127.0.0.1:${NODE_SERVICES_HTTP_PORT:-4319}:4319"',
    );
    expect(compose).toContain(
      '"127.0.0.1:${DOCUMENT_RUNTIME_HTTP_PORT:-4321}:4321"',
    );
    expect(compose).not.toContain("platform: linux/amd64");
    expect(compose).not.toContain("DOCUMENT_RUNTIME_MAX_");
    expect(compose).not.toContain("${SERVICE_TOKEN");
    expect(
      await readRepositoryFile(
        "apps/teamhub/deployments/compose/docker-compose.yml",
      ),
    ).not.toContain("${SERVICE_TOKEN");
  });

  it("pins every Dockerfile FROM to an official upstream image digest", async () => {
    const dockerfiles = [
      "apps/web/Dockerfile",
      "apps/node-services/Dockerfile",
      "apps/teamhub/Dockerfile",
    ];
    const officialImage =
      /^(?:node|golang|alpine):[\w.-]+@sha256:[a-f0-9]{64}$/;

    for (const path of dockerfiles) {
      const source = await readRepositoryFile(path);
      const args = new Map<string, string>();
      const stages = new Set<string>();

      for (const rawLine of source.split("\n")) {
        const line = rawLine.trim();
        const arg = line.match(/^ARG\s+([A-Z0-9_]+)=(?:"([^"]+)"|(\S+))/);
        if (arg) {
          args.set(arg[1], arg[2] ?? arg[3]);
        }

        const from = line.match(
          /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i,
        );
        if (!from) {
          continue;
        }

        let image = from[1];
        const variable = image.match(/^\$\{([A-Z0-9_]+)\}$/);
        if (variable) {
          expect(args.has(variable[1]), `${path} missing ${image}`).toBe(true);
          image = args.get(variable[1]) ?? "";
        }

        if (!stages.has(image)) {
          expect(image, path).toMatch(officialImage);
        }

        if (from[2]) {
          stages.add(from[2]);
        }
      }
    }
    for (const composeFile of [
      "docker-compose.yml",
      "apps/teamhub/deployments/compose/docker-compose.yml",
    ]) {
      const compose = await readRepositoryFile(composeFile);
      expect(compose, composeFile).toContain(
        'image: "pgvector/pgvector:0.8.6-pg17-bookworm@sha256:',
      );
      expect(compose, composeFile).not.toContain("pg_textsearch");
    }
  });
});
