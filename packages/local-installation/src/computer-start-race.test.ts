import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeInstance } from "./instance.js";
import { writeSetupChoice } from "./setup-selection.js";
import { connectComputer } from "./computer.js";
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
const owned: number[] = [];
afterEach(async () => {
  for (const pid of owned.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* The fixture daemon already exited. */
    }
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it.each([true, false])(
  "observes an owned daemon after start exits nonzero without a second start (runtime ready=%s)",
  async (ready) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "computer-start-race-"));
    roots.push(root);
    const computer = path.join(root, "computer"),
      daemon = path.join(root, "daemon.cjs"),
      port = path.join(root, "port"),
      pid = path.join(root, "pid"),
      calls = path.join(root, "calls.jsonl");
    await writeFile(
      daemon,
      `const fs=require('fs'),http=require('http');const status={daemon:{state:'running',reconciled: true, gateway_state:'connected',active_operations:0},runtimes:[{type:'codex',status:${JSON.stringify(ready ? "ready" : "authentication_required")}}]};setTimeout(()=>{const server=http.createServer((req,res)=>res.end(JSON.stringify(status)));server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(port)},String(server.address().port)));},200);`,
    );
    await writeFile(
      computer,
      `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='daemon'&&args[1]==='start'){const child=cp.spawn(process.execPath,[${JSON.stringify(daemon)}],{stdio:'ignore',detached:true});fs.writeFileSync(${JSON.stringify(pid)},String(child.pid));child.unref();process.exitCode=9;}if(args[0]==='daemon'&&args[1]==='status'){if(fs.existsSync(${JSON.stringify(port)})){fetch('http://127.0.0.1:'+fs.readFileSync(${JSON.stringify(port)},'utf8')).then(r=>r.text()).then(console.log);}else console.log(JSON.stringify({daemon:{state:'stopped',reconciled: true, gateway_state:'connecting',active_operations:0},runtimes:[]}));}\n`,
      { mode: 0o700 },
    );
    const instance = await initializeInstance({
      name: "race",
      home: root,
      computerExecutable: computer,
    });
    await writeSetupChoice(instance, "codex");
    await writeFile(
      instance.computerConfig,
      JSON.stringify({ runner_id: "retained-identity" }),
      { mode: 0o600 },
    );
    let result;
    try {
      result = await connectComputer(instance, { interactive: false });
    } finally {
      const fixturePid = Number(await readFile(pid, "utf8").catch(() => 0));
      if (fixturePid) owned.push(fixturePid);
    }
    expect(result.state).toBe(ready ? "ready" : "action_required");
    expect(result.connected).toBe(true);
    if (!ready) expect(result.detail).toContain("runtime");
    const commands = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(
      commands.filter((args) => args.slice(0, 2).join(" ") === "daemon start"),
    ).toHaveLength(1);
    expect(
      commands.every((args) => args.includes(instance.computerConfig)),
    ).toBe(true);
    expect(
      JSON.parse(await readFile(instance.computerConfig, "utf8")).runner_id,
    ).toBe("retained-identity");
  },
);
