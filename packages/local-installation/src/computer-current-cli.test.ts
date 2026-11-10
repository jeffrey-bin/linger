import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeInstance } from "./instance.js";
import { writeSetupChoice } from "./setup-selection.js";
import { connectComputer, inspectComputer, stopComputer } from "./computer.js";

vi.mock("./localmodels-tool.js", () => ({
  runLocalmodels: async () => ({
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      schema: "localmodels.harness-status/v1",
      runtimes: [],
    }),
  }),
}));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// Synthetic process contract from Computer 0.40's published login/daemon help.
// Login starts the daemon; connection/reconciliation can finish after it returns.
it("enrolls and starts the current Computer CLI automatically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "computer-current-cli-"));
  roots.push(root);
  const executable = path.join(root, "computer"),
    calls = path.join(root, "calls.jsonl"),
    running = path.join(root, "running");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2),config=args[args.indexOf('--config')+1];
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='login') {if(!args.includes('--token-file'))process.exit(8);fs.writeFileSync(config,JSON.stringify({runner_id:'same-owned-device'}));fs.writeFileSync(${JSON.stringify(running)},'connecting');}
else if(args[0]==='daemon'&&args[1]==='start'){if(fs.existsSync(${JSON.stringify(running)}))process.exit(9);fs.writeFileSync(${JSON.stringify(running)},'connected');}
else if(args[0]==='daemon'&&args[1]==='stop')fs.rmSync(${JSON.stringify(running)},{force:true});
else if(args[0]==='daemon'&&args[1]==='status'){const active=fs.existsSync(${JSON.stringify(running)}),connected=active&&fs.readFileSync(${JSON.stringify(running)},'utf8')==='connected';if(active&&!connected)fs.writeFileSync(${JSON.stringify(running)},'connected');console.log(JSON.stringify({version:1,config:{configured:true},daemon:active?{state:'running',gateway_state:connected?'connected':'connecting',reconciled:connected,active_operations:0}:{state:'stopped'},runtimes:active?[{type:'codex',status:'ready'}]:[]}));}
else {console.error('Unknown command: '+args.join(' '));process.exit(9);}
`,
    { mode: 0o700 },
  );
  const instance = await initializeInstance({
    home: root,
    name: "current",
    computerExecutable: executable,
  });
  await writeSetupChoice(instance, "codex");
  const token = path.join(instance.root, "enrollment.token");
  await writeFile(token, "synthetic-private-token", { mode: 0o600 });
  const authorize = vi.fn(async () => token);
  expect(
    (await connectComputer(instance, { interactive: false, authorize })).state,
  ).toBe("ready");
  await connectComputer(instance, { interactive: false, authorize });
  const initialCommands = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  expect(
    initialCommands.some((args) => args[0] === "daemon" && args[1] === "start"),
  ).toBe(false);
  expect(authorize).toHaveBeenCalledOnce();
  expect(
    JSON.parse(await readFile(instance.computerConfig, "utf8")).runner_id,
  ).toBe("same-owned-device");
  await stopComputer(instance);
  expect((await inspectComputer(instance)).state).toBe("offline");
  expect(
    (await connectComputer(instance, { interactive: false, authorize })).state,
  ).toBe("ready");
  expect(authorize).toHaveBeenCalledOnce();
  const commands = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  expect(commands.filter((args) => args[0] === "login")).toHaveLength(1);
  expect(
    commands.filter((args) => args[0] === "daemon" && args[1] === "start"),
  ).toHaveLength(1);
  expect(
    commands.find((args) => args[0] === "daemon" && args[1] === "stop"),
  ).toContain("--if-idle");
  expect(commands.every((args) => args.includes(instance.computerConfig))).toBe(
    true,
  );
  expect(JSON.stringify(commands)).not.toContain("synthetic-private-token");
});
