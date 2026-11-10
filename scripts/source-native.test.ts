import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NATIVE_COMPUTER_PROJECTS,
  NATIVE_DEPENDENCY_STORE,
  NATIVE_SERVICE_PROJECTS,
  OFFLINE_DIRECTORY,
  planNativeCommand,
  PREBUILT_DIRECTORY,
  readOffline,
  readPrebuilt,
  teamhubBinary,
} from "./source-native.mjs";

describe("native source commands", () => {
  const repo = "/private/source checkout";
  const tools = {
    node: "/private/node",
    pnpm: "/private/pnpm",
    go: "/private/go",
  };
  it("migrates with the existing Go entry and keeps compiler work bounded", () => {
    const plan = planNativeCommand("migrate", repo, tools);
    expect(plan).toMatchObject({
      command: tools.go,
      args: ["run", "./cmd/migrate"],
      cwd: `${repo}/apps/teamhub`,
      env: { GOMAXPROCS: "2", GOFLAGS: "-p=2 -buildvcs=false" },
    });
  });
  it("inherits stdin and never puts the owner password in argv", () => {
    expect(
      planNativeCommand("owner", repo, tools, {
        OWNER_EMAIL: "owner@test.local",
      }),
    ).toMatchObject({
      args: [
        "run",
        "./cmd/account",
        "create-owner",
        "--email",
        "owner@test.local",
        "--password-stdin",
      ],
    });
  });
  it("runs the desktop's prebuilt TeamHub commands instead of Go", () => {
    const binary = (name: string) => ({
      file: `/private/prebuilt/${name}.exe`,
      sha256: name.padEnd(64, "0"),
    });
    const prebuilt = {
      teamhub: binary("teamhub"),
      migrate: binary("migrate"),
      account: binary("account"),
    };
    const withBinaries = { ...tools, prebuilt };
    expect(planNativeCommand("migrate", repo, withBinaries)).toMatchObject({
      command: prebuilt.migrate.file,
      args: [],
      cwd: `${repo}/apps/teamhub`,
      verify: prebuilt.migrate.sha256,
    });
    expect(
      planNativeCommand("owner", repo, withBinaries, {
        OWNER_EMAIL: "owner@test.local",
      }),
    ).toMatchObject({
      command: prebuilt.account.file,
      args: ["create-owner", "--email", "owner@test.local", "--password-stdin"],
      verify: prebuilt.account.sha256,
    });
    const teamhub = planNativeCommand("teamhub", repo, withBinaries);
    expect(teamhub).toMatchObject({
      command: prebuilt.teamhub.file,
      args: [],
      env: { GIN_MODE: "release" },
      verify: prebuilt.teamhub.sha256,
    });
    expect(teamhub).not.toHaveProperty("run");
  });
  it("runs the desktop's built services instead of the development servers", () => {
    const offline = `${repo}/${OFFLINE_DIRECTORY}`;
    const withServices = { ...tools, offline };
    expect(
      planNativeCommand("node-services", repo, withServices),
    ).toMatchObject({
      command: tools.node,
      args: [
        "--conditions=linger-production",
        `${offline}/node-services/dist/supervisor.js`,
        "--compiled",
      ],
      // Relative settings such as AGENT_HOME stay outside the runtime.
      cwd: repo,
    });
    expect(planNativeCommand("web", repo, withServices)).toMatchObject({
      command: tools.node,
      args: [`${offline}/web/static-host.mjs`],
      cwd: `${offline}/web`,
    });
    for (const operation of ["node-services", "web"])
      expect(planNativeCommand(operation, repo, withServices).command).not.toBe(
        tools.pnpm,
      );
  });
  it("reads built services only for this computer", () => {
    const checkout = mkdtempSync(path.join(os.tmpdir(), "source-offline-"));
    try {
      expect(readOffline(checkout, "win32-x64")).toBeUndefined();
      const directory = path.join(checkout, OFFLINE_DIRECTORY);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "files.json"),
        JSON.stringify({ schema: 1, target: "win32-x64", files: {} }),
      );
      expect(readOffline(checkout, "win32-x64")).toBe(directory);
      expect(readOffline(checkout, "linux-x64")).toBeUndefined();
      // The layout of another desktop release.
      writeFileSync(
        path.join(directory, "files.json"),
        JSON.stringify({ target: "win32-x64", files: {} }),
      );
      expect(readOffline(checkout, "win32-x64")).toBeUndefined();
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
  it("reads prebuilt commands only for this computer", () => {
    const checkout = mkdtempSync(path.join(os.tmpdir(), "source-prebuilt-"));
    try {
      expect(readPrebuilt(checkout, "win32-x64")).toBeUndefined();
      const directory = path.join(checkout, PREBUILT_DIRECTORY);
      mkdirSync(directory, { recursive: true });
      const manifest = (file: string) =>
        writeFileSync(
          path.join(directory, "manifest.json"),
          JSON.stringify({
            target: "win32-x64",
            binaries: { teamhub: { file, sha256: "a".repeat(64) } },
          }),
        );
      manifest("teamhub.exe");
      expect(readPrebuilt(checkout, "win32-x64")).toEqual({
        teamhub: {
          file: path.join(directory, "teamhub.exe"),
          sha256: "a".repeat(64),
        },
      });
      expect(readPrebuilt(checkout, "linux-x64")).toBeUndefined();
      manifest("../teamhub.exe");
      expect(() => readPrebuilt(checkout, "win32-x64")).toThrow(
        "Invalid prebuilt TeamHub file",
      );
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
  it("uses the existing watchers and release builder with no container preparation", () => {
    expect(planNativeCommand("teamhub", repo, tools)).toMatchObject({
      command: tools.go,
      args: ["build", "-o", teamhubBinary(repo), "./cmd/teamhub"],
      cwd: `${repo}/apps/teamhub`,
      env: { GIN_MODE: "release" },
      run: teamhubBinary(repo),
    });
    expect(planNativeCommand("node-services", repo, tools)).toMatchObject({
      command: tools.pnpm,
      cwd: repo,
      args: [
        "exec",
        "tsx",
        "watch",
        "--include",
        "apps/node-services/src/**/*",
        "--include",
        "packages/**/*.ts",
        "--include",
        "contracts/generated/typescript/src/**/*.ts",
        "apps/node-services/scripts/dev-supervisor.ts",
      ],
    });
    expect(planNativeCommand("web", repo, tools).args).toEqual([
      "--filter",
      "@linger/web",
      "dev",
    ]);
    expect(
      planNativeCommand("computer-release", repo, tools, {
        COMPUTER_RELEASE_DIR: "/private/release",
      }).args,
    ).toEqual([
      `${repo}/scripts/prepare-local-computer-release.mjs`,
      "--targets",
      `${process.platform}-${process.arch}`,
      "--output",
      "/private/release",
    ]);
    for (const op of [
      "prepare",
      "prepare-computer",
      "migrate",
      "owner",
      "computer-release",
      "teamhub",
      "node-services",
      "web",
    ])
      expect(JSON.stringify(planNativeCommand(op, repo, tools))).not.toContain(
        "docker",
      );
  });
  it("installs only the projects the native services run, patiently", () => {
    const flags = [
      "--frozen-lockfile",
      "--trust-lockfile",
      "--prefer-offline",
      "--reporter",
      "append-only",
      "--fetch-timeout",
      "1800000",
      "--fetch-retries",
      "5",
      "--fetch-retry-mintimeout",
      "10000",
      "--fetch-retry-maxtimeout",
      "120000",
    ];
    expect(planNativeCommand("prepare", repo, tools)).toMatchObject({
      command: tools.pnpm,
      cwd: repo,
      args: [
        "install",
        "--filter",
        "@linger/node-services...",
        "--filter",
        "@linger/web...",
        ...flags,
      ],
    });
    expect(planNativeCommand("prepare-computer", repo, tools).args).toEqual([
      "install",
      "--filter",
      "@linger/computer...",
      "--filter",
      "@linger/teamhub-cli...",
      ...flags,
    ]);
  });
  it("covers every project whose code a native operation runs", () => {
    const name = (directory: string) =>
      JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"))
        .name;
    const checkout = ".";
    const nodeServices = planNativeCommand("node-services", checkout, tools);
    expect(NATIVE_SERVICE_PROJECTS).toContain(
      name(path.dirname(path.dirname(nodeServices.args.at(-1)!))),
    );
    expect(NATIVE_SERVICE_PROJECTS).toContain(
      planNativeCommand("web", checkout, tools).args[1],
    );
    const release = readFileSync(
      "scripts/prepare-local-computer-release.mjs",
      "utf8",
    );
    for (const directory of ["apps/computer", "apps/teamhub-cli"]) {
      expect(release).toContain(directory);
      expect(NATIVE_COMPUTER_PROJECTS).toContain(name(directory));
    }
  });
  it("installs offline from a bundled dependency store", () => {
    const checkout = mkdtempSync(
      path.join(os.tmpdir(), "source-native-store-"),
    );
    try {
      expect(planNativeCommand("prepare", checkout, tools).args).not.toContain(
        "--store-dir",
      );
      mkdirSync(path.join(checkout, NATIVE_DEPENDENCY_STORE), {
        recursive: true,
      });
      expect(
        planNativeCommand("prepare", checkout, tools).args.slice(-2),
      ).toEqual(["--store-dir", path.join(checkout, NATIVE_DEPENDENCY_STORE)]);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
  it("rejects unknown operations", () =>
    expect(() => planNativeCommand("up", repo, tools)).toThrow(
      "Unknown native source operation",
    ));
});

it("merges the instance environment, preserves cwd and passes owner stdin to the existing CLI", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "source-native-test-"));
  try {
    const resultFile = path.join(temporary, "result.json");
    const fakeGo = path.join(temporary, "go");
    const envFile = path.join(temporary, "instance.env");
    writeFileSync(envFile, "OWNER_EMAIL=from-instance@example.test\n");
    writeFileSync(
      fakeGo,
      `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),input:readFileSync(0,'utf8'),jobs:process.env.GOMAXPROCS}));
`,
    );
    chmodSync(fakeGo, 0o755);
    const environment = { ...process.env };
    delete environment.OWNER_EMAIL;
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/source-native.mjs"), "owner"],
      {
        env: {
          ...environment,
          LOCAL_ENV_FILE: envFile,
          PATH: `${temporary}:${process.env.PATH}`,
        },
        input: "private-password",
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual({
      args: [
        "run",
        "./cmd/account",
        "create-owner",
        "--email",
        "from-instance@example.test",
        "--password-stdin",
      ],
      cwd: path.resolve("apps/teamhub"),
      input: "private-password",
      jobs: "2",
    });
    expect(result.stdout + result.stderr).not.toContain("private-password");
    expect(result.stderr).not.toContain(
      "sets names no service reads: OWNER_EMAIL",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

it("names the TeamHub binary so Windows can run it", () => {
  expect(teamhubBinary("/repo", "win32")).toBe(
    path.join("/repo", ".simplexai-runtime/teamhub", "teamhub.exe"),
  );
  expect(teamhubBinary("/repo", "linux")).toBe(
    path.join("/repo", ".simplexai-runtime/teamhub", "teamhub"),
  );
});

describe("native TeamHub", () => {
  function run(goScript: string) {
    const temporary = mkdtempSync(
      path.join(os.tmpdir(), "source-native-test-"),
    );
    const fakeGo = path.join(temporary, "go");
    writeFileSync(fakeGo, `#!${process.execPath}\n${goScript}\n`);
    chmodSync(fakeGo, 0o755);
    const envFile = path.join(temporary, "instance.env");
    writeFileSync(envFile, "");
    try {
      return {
        temporary,
        result: spawnSync(
          process.execPath,
          [path.resolve("scripts/source-native.mjs"), "teamhub"],
          {
            env: {
              ...process.env,
              LOCAL_ENV_FILE: envFile,
              PATH: `${temporary}:${process.env.PATH}`,
            },
            encoding: "utf8",
          },
        ),
      };
    } finally {
      rmSync(teamhubBinary(path.resolve(".")), { force: true });
      rmSync(path.resolve(PREBUILT_DIRECTORY), {
        recursive: true,
        force: true,
      });
    }
  }

  // A prebuilt `teamhub` in this checkout that records how it ran.
  function prebuild(record: string, tamper = false) {
    const directory = path.resolve(PREBUILT_DIRECTORY);
    mkdirSync(directory, { recursive: true });
    const body = `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(record)}, JSON.stringify({cwd: process.cwd(), mode: process.env.GIN_MODE}));\n`;
    writeFileSync(path.join(directory, "teamhub"), body, { mode: 0o755 });
    const sha256 = createHash("sha256")
      .update(tamper ? `${body}#` : body)
      .digest("hex");
    writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        target: `${process.platform}-${process.arch}`,
        binaries: { teamhub: { file: "teamhub", sha256 } },
      }),
    );
  }

  it("runs the prebuilt TeamHub without Go", () => {
    const record = path.join(
      mkdtempSync(path.join(os.tmpdir(), "source-native-ran-")),
      "ran.json",
    );
    prebuild(record);
    const { temporary, result } = run(
      `console.error("go must not run"); process.exit(3);`,
    );
    try {
      if (result.status !== 0) throw new Error(result.stderr);
      expect(result.stdout).not.toContain("building...");
      expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
        cwd: path.resolve("apps/teamhub"),
        mode: "release",
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      rmSync(path.dirname(record), { recursive: true, force: true });
    }
  });

  it("refuses a prebuilt TeamHub that no longer matches its manifest", () => {
    prebuild(path.join(os.tmpdir(), "never-written.json"), true);
    const { temporary, result } = run(`process.exit(3);`);
    try {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("teamhub does not match its manifest");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("builds once and runs the binary in place of a watcher", () => {
    const { temporary, result } = run(
      `import {writeFileSync,chmodSync} from 'node:fs'; import path from 'node:path';
const out = process.argv[process.argv.indexOf('-o') + 1];
const record = path.join(path.dirname(process.argv[1]), 'ran.json');
writeFileSync(out, '#!' + process.execPath + "\\nimport {writeFileSync} from 'node:fs'; writeFileSync(" + JSON.stringify(record) + ", JSON.stringify({cwd: process.cwd(), mode: process.env.GIN_MODE}));\\n");
chmodSync(out, 0o755);
writeFileSync(path.join(path.dirname(process.argv[1]), 'built.json'), JSON.stringify(process.argv.slice(2)));`,
    );
    try {
      if (result.status !== 0) throw new Error(result.stderr);
      expect(result.stdout).toContain("building...");
      expect(
        JSON.parse(readFileSync(path.join(temporary, "built.json"), "utf8")),
      ).toEqual([
        "build",
        "-o",
        teamhubBinary(path.resolve(".")),
        "./cmd/teamhub",
      ]);
      expect(
        JSON.parse(readFileSync(path.join(temporary, "ran.json"), "utf8")),
      ).toEqual({ cwd: path.resolve("apps/teamhub"), mode: "release" });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("logs a failed build the way the installer reads it", () => {
    const { temporary, result } = run(
      `console.error("internal/artifact/storage.go:276:17: undefined: unix.Statfs_t"); process.exit(2);`,
    );
    try {
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("building...");
      expect(result.stderr).toContain(
        "internal/artifact/storage.go:276:17: undefined: unix.Statfs_t\nfailed to build, error: exit status 2",
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe("native source launcher", () => {
  // Windows cannot replace a process, so a launcher between the installer and
  // the service would stay resident; the environment merges in this process.
  it("merges the checkout's environment itself and starts the service directly", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "source-native-launch-"));
    try {
      mkdirSync(path.join(root, "scripts"));
      for (const file of [
        "source-native.mjs",
        "with-local-env.mjs",
        "replace-process.mjs",
        "env-inventory.json",
      ])
        writeFileSync(
          path.join(root, "scripts", file),
          readFileSync(path.join(import.meta.dirname, file)),
        );
      writeFileSync(path.join(root, ".env.example"), "");
      writeFileSync(
        path.join(root, "scripts/local-defaults.env"),
        "PORT=1\nHOST=0.0.0.0\n",
      );
      writeFileSync(path.join(root, "native.env"), "PORT=4321\n");
      // A web server that prints what it was started with.
      const offline = path.join(root, OFFLINE_DIRECTORY);
      mkdirSync(path.join(offline, "web"), { recursive: true });
      writeFileSync(
        path.join(offline, "web/static-host.mjs"),
        "console.log(JSON.stringify({ port: process.env.PORT, host: process.env.HOST }));",
      );
      writeFileSync(
        path.join(offline, "files.json"),
        JSON.stringify({
          schema: 1,
          target: `${process.platform}-${process.arch}`,
        }),
      );
      const plan = spawnSync(
        process.execPath,
        [path.join(root, "scripts/source-native.mjs"), "web"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            LOCAL_ENV_FILE: "native.env",
            HOST: "127.0.0.1",
          },
        },
      );
      expect(plan.stderr).toBe("");
      expect(JSON.parse(plan.stdout)).toMatchObject({
        port: "4321",
        host: "127.0.0.1",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
