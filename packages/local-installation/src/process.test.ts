import { expect, it } from "vitest";
import { runProcess } from "./process.js";
it("executes argument arrays literally and preserves JSON output", async () => {
  const value = "$(touch /tmp/never-linger); a b";
  const result = await runProcess(process.execPath, [
    "-e",
    "console.log(JSON.stringify(process.argv.slice(1)))",
    value,
  ]);
  expect(JSON.parse(result.stdout)).toEqual([value]);
  expect(result.code).toBe(0);
});
it("reports nonzero exit without exposing argv in errors", async () => {
  expect(
    (await runProcess(process.execPath, ["-e", "process.exit(7)"])).code,
  ).toBe(7);
  await expect(
    runProcess("/missing-linger-private-secret", []),
  ).rejects.toThrow(/unavailable/i);
});
it("bounds captured output rather than buffering forever", async () => {
  await expect(
    runProcess(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(3_000_000))",
    ]),
  ).rejects.toThrow(/output/i);
});
it("aborts and times out actual children", async () => {
  const controller = new AbortController();
  const child = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 30);
  await expect(child).rejects.toMatchObject({ name: "AbortError" });
  await expect(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 30,
    }),
  ).rejects.toMatchObject({
    code: "COMMAND_TIMEOUT",
    message: "Command timed out",
  });
});
it("captures stderr separately and kills a stubborn child process group", async () => {
  const result = await runProcess(process.execPath, [
    "-e",
    "process.stdout.write('ok');process.stderr.write('diagnostic')",
  ]);
  expect(result).toEqual({ stdout: "ok", stderr: "diagnostic", code: 0 });
  const controller = new AbortController();
  let descendant = 0;
  const run = runProcess(
    process.execPath,
    [
      "-e",
      `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`,
    ],
    {
      signal: controller.signal,
      onOutput: (value) => {
        descendant = Number(value.trim());
        controller.abort();
      },
    },
  );
  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(() => process.kill(descendant, 0)).toThrow();
});
it("can stream long-lived output without accumulating capture buffers", async () => {
  let bytes = 0;
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(3_000_000))"],
    {
      capture: false,
      onOutput: (value) => {
        bytes += value.length;
      },
    },
  );
  expect(bytes).toBe(3_000_000);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
});

it("pipes private input to the child without putting it in argv, environment or output", async () => {
  const secret = "fixture-stdin-password\n";
  const output: string[] = [];
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data', c=>input+=c);process.stdin.on('end',()=>console.log(JSON.stringify({matched:input==='fixture-stdin-password\\n',args:process.argv.slice(1),envLeak:Object.values(process.env).includes(input.trim())})))`,
    ],
    { input: secret, onOutput: (value) => output.push(value) },
  );
  expect(JSON.parse(result.stdout)).toEqual({
    matched: true,
    args: [],
    envLeak: false,
  });
  expect(output.join("").includes(secret.trim())).toBe(false);
});
it("handles closed stdin without uncaught EPIPE or exposing private input", async () => {
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      "require('node:fs').closeSync(0);setTimeout(()=>process.exit(0),100)",
    ],
    { input: "fixture-private-input".repeat(500_000) },
  ).then(
    () => "success",
    (error: Error) => error.message,
  );
  expect(result).toMatch(/input|stdin/i);
  expect(result).not.toContain("fixture-private-input");
});
it("cancels a child with a blocked stdin write", async () => {
  const controller = new AbortController();
  const running = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    {
      input: "fixture-private-input".repeat(500_000),
      signal: controller.signal,
    },
  );
  setTimeout(() => controller.abort(), 30);
  await expect(running).rejects.toMatchObject({ name: "AbortError" });
});

it("streams archive bytes into a native child without buffering them in argv", async () => {
  const { Readable } = await import("node:stream");
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      "let n=0;process.stdin.on('data',x=>n+=x.length);process.stdin.on('end',()=>console.log(n))",
    ],
    { inputStream: Readable.from([Buffer.alloc(12345)]) },
  );
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("12345");
});
