import { execFile, spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "local env fixture "));
  fixtures.push(root);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(path.join(root, ".env"), "FIXTURE_VALUE=wrong-default\n");
  await writeFile(
    path.join(root, "selected.env"),
    "FIXTURE_VALUE=selected\nFIXTURE_LITERAL='$(exit 99)'\n",
  );
  await copyFile(
    path.join(repository, "scripts/with-local-env.mjs"),
    path.join(root, "scripts/with-local-env.mjs"),
  );
  // The launcher warns about env file names these lists do not know.
  await writeFile(
    path.join(root, ".env.example"),
    "FIXTURE_VALUE=\n# LISTED_COMMENTED=\n",
  );
  await writeFile(
    path.join(root, "scripts/env-inventory.json"),
    JSON.stringify({
      indirect: { INDIRECT_NAME: "fixture" },
      unlisted: {
        fixture: {
          owner: "fixture",
          description: "fixture",
          names: ["UNLISTED_NAME"],
        },
      },
    }),
  );
  return root;
}

it("node-services passes the selected root-relative or absolute env file to its real child", async () => {
  const root = await fixture();
  const appRoot = path.join(root, "apps/node-services");
  await mkdir(path.join(appRoot, "src/agent/agent-features"), {
    recursive: true,
  });
  await writeFile(
    path.join(appRoot, "src/main.ts"),
    "console.log(JSON.stringify({value:process.env.FIXTURE_VALUE,literal:process.env.FIXTURE_LITERAL}));" +
      'process.kill(process.ppid, "SIGTERM"); setInterval(() => {}, 1000);',
  );
  await mkdir(path.join(appRoot, "scripts"));
  // The supervisor regenerates the feature catalog before each start.
  for (const script of ["dev-supervisor.ts", "generate-feature-catalog.ts"]) {
    await copyFile(
      path.join(repository, "apps/node-services/scripts", script),
      path.join(appRoot, "scripts", script),
    );
  }
  await mkdir(path.join(root, "node_modules/tsx"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules/tsx/package.json"),
    '{"type":"module","exports":"./index.mjs"}',
  );
  // Node 26 strips fixture TypeScript natively. The preload only supplies
  // local health readiness; the real supervisor must pass env to its child.
  await writeFile(
    path.join(root, "node_modules/tsx/index.mjs"),
    "globalThis.fetch = async () => new Response(null, { status: 200 });",
  );
  const pkg = JSON.parse(
    await readFile(
      path.join(repository, "apps/node-services/package.json"),
      "utf8",
    ),
  );
  const command = pkg.scripts.start;
  for (const selection of ["selected.env", path.join(root, "selected.env")]) {
    const { stdout } = await execute("sh", ["-c", command], {
      cwd: appRoot,
      env: {
        HOME: root,
        PATH: process.env.PATH,
        LOCAL_ENV_FILE: selection,
        TEAMHUB_BASE_URL: "http://fixture.invalid",
      },
    });
    expect(JSON.parse(stdout)).toEqual({
      value: "selected",
      literal: "$(exit 99)",
    });
  }
  const { stdout } = await execute("sh", ["-c", command], {
    cwd: appRoot,
    env: {
      PATH: process.env.PATH,
      LOCAL_ENV_FILE: "selected.env",
      FIXTURE_VALUE: "shell",
      TEAMHUB_BASE_URL: "http://fixture.invalid",
    },
  });
  expect(JSON.parse(stdout).value).toBe("shell");
});

it("passes the same selected environment through root service scripts and TeamHub Make", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "bin"));
  await mkdir(path.join(root, "apps/teamhub"), { recursive: true });
  await copyFile(
    path.join(repository, "apps/teamhub/Makefile"),
    path.join(root, "apps/teamhub/Makefile"),
  );
  for (const command of ["pnpm", "docker", "go"]) {
    await writeFile(
      path.join(root, "bin", command),
      `#!${process.execPath}\nif (process.argv[2] === "env" && process.argv[3] === "GOVERSION") { console.log("go1.26.5"); process.exit(0); }\nconsole.log(JSON.stringify({args:process.argv.slice(2),value:process.env.FIXTURE_VALUE,file:process.env.LOCAL_ENV_FILE,literal:process.env.FIXTURE_LITERAL}));`,
      { mode: 0o755 },
    );
  }
  const environment = {
    HOME: root,
    PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
    LOCAL_ENV_FILE: "selected.env",
    FIXTURE_VALUE: "shell",
  };
  const pkg = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  );
  const commands = [
    pkg.scripts["dev:node-services"],
    "make -s -C apps/teamhub dev-migrate",
    "make -s -C apps/teamhub e2e-identity",
    "make -s -C apps/teamhub watch",
  ];
  for (const command of commands) {
    const { stdout } = await execute("sh", ["-c", command], {
      cwd: root,
      env: environment,
    });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      value: "shell",
      file: path.join(root, "selected.env"),
      literal: "$(exit 99)",
    });
    if (result.args.includes("compose"))
      expect(result.args.slice(0, 3)).toEqual([
        "compose",
        "--env-file",
        path.join(root, "selected.env"),
      ]);
  }
});

it("layers the env file over the defaults file", async () => {
  const root = await fixture();
  await writeFile(
    path.join(root, "scripts/local-defaults.env"),
    "DEFAULT_ONLY=default\nFIXTURE_VALUE=default\n",
  );
  const { stdout } = await execute(
    process.execPath,
    [
      path.join(root, "scripts/with-local-env.mjs"),
      "--",
      process.execPath,
      "-e",
      "const e=process.env;console.log(JSON.stringify([e.DEFAULT_ONLY,e.FIXTURE_VALUE]))",
    ],
    { env: { HOME: root, PATH: process.env.PATH } },
  );
  expect(JSON.parse(stdout)).toEqual(["default", "wrong-default"]);
});

it("warns about env file names no list knows without stopping the start", async () => {
  const root = await fixture();
  await writeFile(
    path.join(root, "scripts/local-defaults.env"),
    "DEFAULT_NAME=fixed\n",
  );
  const launch = () =>
    execute(
      process.execPath,
      [
        path.join(root, "scripts/with-local-env.mjs"),
        "--",
        process.execPath,
        "-e",
        "console.log(process.env.RETIRED_NAME ?? process.env.FIXTURE_VALUE)",
      ],
      { env: { HOME: root, PATH: process.env.PATH } },
    );
  await writeFile(
    path.join(root, ".env"),
    [
      "FIXTURE_VALUE=listed",
      "LISTED_COMMENTED=1",
      "INDIRECT_NAME=1",
      "UNLISTED_NAME=1",
      "DEFAULT_NAME=1",
    ].join("\n"),
  );
  await expect(launch()).resolves.toEqual({ stdout: "listed\n", stderr: "" });

  await writeFile(
    path.join(root, ".env"),
    "FIXTURE_VALUE=listed\nRETIRED_NAME=kept\nOTHER_RETIRED=1\n",
  );
  const { stdout, stderr } = await launch();
  expect(stdout).toBe("kept\n");
  expect(stderr.trimEnd().split("\n")).toEqual([
    expect.stringContaining(
      ".env sets names no service reads: OTHER_RETIRED, RETIRED_NAME.",
    ),
  ]);
});

it("fails before launching a child for a missing required env file and preserves child failures", async () => {
  const root = await fixture();
  const launcher = path.join(root, "scripts/with-local-env.mjs");
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    LOCAL_ENV_FILE: "missing.env",
  };
  await expect(
    execute(
      process.execPath,
      [launcher, "--", process.execPath, "-e", 'console.log("started")'],
      { env },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringContaining("Missing local environment file"),
  });
  await expect(
    execute(
      process.execPath,
      [
        launcher,
        "--optional",
        "--",
        process.execPath,
        "-e",
        "process.exit(37)",
      ],
      { env },
    ),
  ).rejects.toMatchObject({ code: 37 });
});

it("preserves termination signals when replacing the launcher", async () => {
  const root = await fixture();
  const child = spawn(
    process.execPath,
    [
      path.join(root, "scripts/with-local-env.mjs"),
      "--",
      process.execPath,
      "-e",
      'console.log("ready"); setInterval(() => {}, 1000);',
    ],
    {
      env: { HOME: root, PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  try {
    await expect.poll(() => output, { timeout: 5000 }).toContain("ready");
    child.kill("SIGTERM");
    await expect(exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
});
