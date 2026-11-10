import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { commandDefinitions } from "./domain-commands.js";

async function run(args: readonly string[]): Promise<string> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(args, {
    cwd: "/",
    env: {},
    fetch: () => Promise.reject(new Error("help and schema are offline")),
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
  });
  return `exit ${code}\n${stdout.join("")}${stderr.join("")}`;
}

// Help and schemas are the CLI's public surface: any change here must be a
// deliberate edit of the snapshot, never a side effect of a refactor.
describe("offline help and schema snapshot", () => {
  it("keeps the root and group help", async () => {
    const groups = [
      ...new Set(commandDefinitions.map(({ command }) => command[0]!)),
    ].sort();
    const pages: Record<string, string> = { "": await run(["--help"]) };
    for (const group of groups) pages[group] = await run(["help", group]);
    expect(pages).toMatchSnapshot();
  });

  it("keeps every command's help and schema", async () => {
    const pages: Record<string, { help: string; schema: string }> = {};
    for (const { command } of commandDefinitions)
      pages[command.join(" ")] = {
        help: await run([...command, "--help"]),
        schema: await run([...command, "--schema", "--json"]),
      };
    expect(pages).toMatchSnapshot();
  });
});
