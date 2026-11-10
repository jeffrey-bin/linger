import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("builds production Web assets without invoking Computer packaging", () => {
  const root = mkdtempSync(join(tmpdir(), "web-quality-"));
  try {
    const log = join(root, "commands");
    writeFileSync(
      join(root, "pnpm"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n',
    );
    chmodSync(join(root, "pnpm"), 0o755);
    execFileSync("make", ["check-web-build"], {
      env: {
        ...process.env,
        COMMAND_LOG: log,
        PATH: `${root}:${process.env.PATH}`,
      },
    });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "--filter @linger/web test:build",
      "--filter @linger/web run build:assets",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
