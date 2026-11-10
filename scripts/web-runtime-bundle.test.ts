import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("serves assets and health from a standalone runtime without node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-runtime-bundle-"));
  let server;
  try {
    execFileSync(
      "bash",
      ["scripts/ci/build-web-runtime.sh", join(root, "static-host.mjs")],
      { stdio: "pipe" },
    );
    await mkdir(join(root, "dist"));
    await writeFile(
      join(root, "dist", "index.html"),
      "<html>standalone</html>",
    );
    const { createStaticHost } = await import(
      pathToFileURL(join(root, "static-host.mjs")).href
    );
    server = createServer(createStaticHost());
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === "object" && address!.port}`;
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    expect(
      await (
        await fetch(`${origin}/rooms/one`, { headers: { accept: "text/html" } })
      ).text(),
    ).toContain("standalone");
    expect((await fetch(`${origin}/v0/missing`)).status).toBe(404);
  } finally {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
