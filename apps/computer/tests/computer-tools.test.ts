import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("keeps Pi's public MCP extension bound to private Operation proxies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-pi-extension-"));
  try {
    const result = await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from "node:assert/strict";
      import { chmodSync, writeFileSync } from "node:fs";
      import { loadManagedMcpConfig } from ${JSON.stringify(new URL("../tools/pi-mcp.mjs", import.meta.url).href)};
      const file = ${JSON.stringify(path.join(root, "mcp.json"))};
      const write = (server) => writeFileSync(file, JSON.stringify({mcpServers:{computer:server}}),{mode:0o600});
      write({type:"http",url:"http://127.0.0.1:1234/mcp/fixture"});
      const config=loadManagedMcpConfig(file);
      assert.equal(config.autoEnableCodemode,false);
      assert.equal(config.servers[0].config.exposure,"direct");
      for(const server of [
        {type:"http",url:"https://example.com"},
        {type:"http",url:"http://localhost:1234"},
        {type:"http",url:"http://secret@127.0.0.1:1234"},
        {type:"http",url:"http://127.0.0.1:1234",headers:{Authorization:"credential"}},
        {type:"stdio",url:"http://127.0.0.1:1234",command:"untrusted"}
      ]){write(server);assert.throws(()=>loadManagedMcpConfig(file));}
      write({type:"http",url:"http://127.0.0.1:1234"});
      if(process.platform!=="win32"){chmodSync(file,0o644);assert.throws(()=>loadManagedMcpConfig(file),/private/);}
      console.log("private immutable MCP configuration passed");
    `,
      ],
      { timeout: 20_000 },
    );
    expect(result.stdout).toContain(
      "private immutable MCP configuration passed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
