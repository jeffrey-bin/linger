import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeInstance } from "./instance.js";
import { writeSetupChoice } from "./setup-selection.js";
import { connectComputer } from "./computer.js";
import { runLocalmodels } from "./localmodels-tool.js";
vi.mock("./localmodels-tool.js", () => ({ runLocalmodels: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("binds selected Codex argv and environment while an unsupported unselected global Claude is present", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "computer-selection-"));
  roots.push(root);
  const computer = path.join(root, "computer");
  const calls = path.join(root, "calls.jsonl");
  const codex = path.join(root, "codex"),
    claude = path.join(root, "claude-2.0.24");
  await writeFile(codex, "fixture");
  await writeFile(claude, "unsupported global Claude");
  vi.stubEnv("LINGER_CLAUDE_PATH", claude);
  vi.stubEnv("LINGER_PI_PATH", "/unselected/pi");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/unselected/claude-profile");
  vi.mocked(runLocalmodels).mockResolvedValue({
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      schema: "localmodels.harness-status/v1",
      runtimes: [
        {
          runtime: "codex",
          executable: codex,
          argvPrefix: [],
          installed: true,
          authenticated: true,
          environment: { CODEX_HOME: "/selected/codex-profile" },
        },
        {
          runtime: "claude",
          executable: claude,
          argvPrefix: [],
          installed: true,
          authenticated: false,
          environment: { CLAUDE_CONFIG_DIR: "/unselected/upstream-claude" },
        },
      ],
    }),
  });
  await writeFile(
    computer,
    `#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2),env=process.env;fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,claude:env.LINGER_CLAUDE_PATH,pi:env.LINGER_PI_PATH,claudeProfile:env.CLAUDE_CONFIG_DIR,codex:env.LINGER_CODEX_PATH,codexProfile:env.CODEX_HOME})+'\\n');if(args[0]==='login'){if(args.includes('--claude-path')||env.LINGER_CLAUDE_PATH||env.LINGER_PI_PATH)process.exit(9);fs.writeFileSync(args[args.indexOf('--config')+1],'{}');}if(args[0]==='daemon'&&args[1]==='status')console.log(JSON.stringify({daemon:{state:'running',reconciled: true, gateway_state:'connected',active_operations:0},runtimes:[{type:'codex',status:'ready'}]}));\n`,
    { mode: 0o700 },
  );
  const instance = await initializeInstance({
    home: root,
    name: "selected",
    computerExecutable: computer,
  });
  await writeSetupChoice(instance, "codex");
  const result = await connectComputer(instance, {
    interactive: false,
    authorize: async () => path.join(root, "enrollment.token"),
  });
  expect(result.state).toBe("ready");
  const records = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          args: string[];
          claude?: string;
          pi?: string;
          claudeProfile?: string;
          codex?: string;
          codexProfile?: string;
        },
    );
  expect(records.find((row) => row.args[0] === "login")?.args).toContain(
    "--codex-path",
  );
  for (const row of records) {
    expect(row.args).not.toContain("--claude-path");
    expect(row.claude).toBeUndefined();
    expect(row.pi).toBeUndefined();
    expect(row.claudeProfile).toBeUndefined();
    expect(row.codex).toBe(codex);
    expect(row.codexProfile).toBe("/selected/codex-profile");
  }
  expect(
    vi
      .mocked(runLocalmodels)
      .mock.calls.every(
        ([, args]) =>
          args.includes("--runtime") &&
          args[args.indexOf("--runtime") + 1] === "codex",
      ),
  ).toBe(true);
});
