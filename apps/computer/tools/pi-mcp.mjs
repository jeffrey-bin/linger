import { readFileSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
// An installed Pi may alias bare package imports to its own version. Resolve
// the pinned public entry by URL so this adapter keeps its shipped API.
const { createMcpExtension } = await import(
  new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    import.meta.url,
  ).href
);

// This explicit extension uses Pi's public MCP implementation. It does not
// discover ambient configuration or create another Agent execution loop.
export function loadManagedMcpConfig(configPath) {
  if (!configPath || !isAbsolute(configPath)) {
    throw new Error("Managed Pi MCP configuration is missing");
  }
  const stat = lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("Managed Pi MCP configuration is unsafe");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Managed Pi MCP configuration must be private");
  }
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  const servers = Object.entries(parsed.mcpServers ?? {}).map(
    ([name, config]) => {
      const url = new URL(config.url);
      if (
        config.type !== "http" ||
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.username ||
        url.password ||
        config.command ||
        config.headers ||
        config.auth ||
        config.oauth
      ) {
        throw new Error("Managed Pi MCP requires a bound local proxy");
      }
      return {
        name,
        config: {
          type: "http",
          url: url.href,
          exposure: "direct",
          timeout: config.tool_timeout_sec ?? 180,
        },
        source: configPath,
        scope: "extension",
      };
    },
  );
  return { servers, autoEnableCodemode: false, errors: [] };
}

export default createMcpExtension({
  loadConfig: () =>
    loadManagedMcpConfig(process.env.LINGER_PI_MANAGED_MCP_CONFIG),
  updateConfig: () => {
    throw new Error("Operation MCP configuration is immutable");
  },
});
