import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const loader = createRequire(import.meta.url).resolve("tsx");
const coordination = new URL(
  "../acceptance/soak-coordination.ts",
  import.meta.url,
).href;

describe("concurrent soak barrier", { timeout: 5_000 }, () => {
  it("resumes the same stdin for Start and Stop and exits after both phases", async () => {
    const result = await runGate("release");
    expect(result.code).toBe(0);
    expect(result.phases).toEqual(["start", "stop"]);
    expect(result.output).toContain("completed");
  });

  it.each(["disconnect", "abort"] as const)(
    "cleans up a pending gate on %s",
    async (mode) => {
      const result = await runGate(mode);
      expect(result.code).toBe(2);
      expect(result.phases).toEqual(["start"]);
      expect(result.output).toContain(
        mode === "abort" ? "interrupted" : "disconnected",
      );
    },
  );
});

function runGate(mode: "release" | "disconnect" | "abort") {
  return new Promise<{ code: number | null; phases: string[]; output: string }>(
    (resolve, reject) => {
      const code = `
      import {waitForSoakGate} from ${JSON.stringify(coordination)};
      const controller = new AbortController();
      if (${JSON.stringify(mode)} === 'abort') setTimeout(() => controller.abort(new Error('interrupted')), 50);
      try {
        await waitForSoakGate('start', controller.signal);
        await waitForSoakGate('stop', controller.signal);
        console.log('completed');
      } catch (error) { console.log(error.message); process.exitCode = 2; }
    `;
      const child = spawn(
        process.execPath,
        ["--import", loader, "--input-type=module", "-e", code],
        {
          env: { ...process.env, VOICE_SOAK_COORDINATED: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 4_000);
      const phases: string[] = [];
      let output = "";
      let pending = "";
      child.stdout.on("data", (data: Buffer) => {
        output += data.toString();
        pending += data.toString();
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith('{"status":"barrier-ready"')) continue;
          const { phase } = JSON.parse(line) as { phase: string };
          phases.push(phase);
          if (mode === "release") child.stdin.write(`${phase}\n`);
          if (mode === "disconnect") child.stdin.end();
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        output += data.toString();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, phases, output });
      });
    },
  );
}
