import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import type { HttpRoute } from "../../http-host.js";
import {
  COMPUTER_RELEASE_TARGETS,
  type ComputerRelease,
  isWindowsTarget,
} from "./computer-release.js";

/**
 * Resolves WEB_PUBLIC_ORIGIN once at startup: an HTTPS or HTTP origin.
 * Unset, the installer is not served; archives and self-update keep working.
 */
export const resolveInstallOrigin = (
  publicOrigin: string | undefined,
): string | undefined => {
  if (!publicOrigin) return undefined;
  const parsed = URL.canParse(publicOrigin) ? new URL(publicOrigin) : undefined;
  if (
    !parsed ||
    parsed.origin !== publicOrigin ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
  ) {
    throw new Error(
      "WEB_PUBLIC_ORIGIN must be an HTTPS or HTTP origin without a path.",
    );
  }
  return parsed.origin;
};

const templateLine = {
  webOrigin: 'web_origin="${LINGER_WEB_URL:-http://localhost:3000}"',
  release: (target: string) => `release_${target.replace("-", "_")}=""`,
};

export interface ShellInstallers {
  readonly install: string;
  readonly uninstall: string;
}

const replaceTemplateLines = (
  template: string,
  replacements: ReadonlyMap<string, string>,
): string => {
  const lines = template.split("\n");
  for (const [marker, replacement] of replacements) {
    const indexes = lines.flatMap((line, index) =>
      line === marker ? [index] : [],
    );
    if (indexes.length !== 1) {
      throw new Error(`Installer template marker is missing: ${marker}`);
    }
    lines[indexes[0]!] = replacement;
  }
  return lines.join("\n");
};

/**
 * Binds the origin into both shell scripts, which name the environment's
 * install root and command after it, and every target's archive digests into
 * the installer.
 */
export const renderShellInstallers = (
  release: Pick<
    ComputerRelease,
    "installerTemplate" | "uninstallerTemplate" | "targets"
  >,
  origin: string,
): ShellInstallers => {
  const originLine: [string, string] = [
    templateLine.webOrigin,
    `web_origin="\${LINGER_WEB_URL:-${origin}}"`,
  ];
  const replacements = new Map<string, string>([
    originLine,
    ...COMPUTER_RELEASE_TARGETS.filter(
      (target) => !isWindowsTarget(target),
    ).map((target): [string, string] => {
      const entry = release.targets[target];
      return [
        templateLine.release(target),
        `release_${target.replace("-", "_")}="${
          entry
            ? `${entry.app.sha256} ${entry.app.size} ${entry.deps.sha256} ${entry.deps.size}`
            : ""
        }"`,
      ];
    }),
  ]);
  return {
    install: replaceTemplateLines(release.installerTemplate, replacements),
    uninstall: replaceTemplateLines(
      release.uninstallerTemplate,
      new Map([originLine]),
    ),
  };
};

const WINDOWS_RELEASE_METADATA_MARKER = "__LINGER_RELEASE_METADATA_BASE64__";

export interface WindowsInstallers {
  readonly install: string;
  readonly uninstall: string;
}

/**
 * Binds the origin and the Windows archive digests into the PowerShell
 * installers, or returns undefined when the image ships no Windows target.
 * The installer names the environment's install root and command after the
 * origin, so one Windows account can hold Computers of several deployments.
 */
export const renderWindowsInstallers = (
  release: Pick<
    ComputerRelease,
    "targets" | "windowsInstallerTemplate" | "windowsUninstallerTemplate"
  >,
  origin: string,
): WindowsInstallers | undefined => {
  const targets = Object.fromEntries(
    Object.entries(release.targets).filter(([target]) =>
      isWindowsTarget(target),
    ),
  );
  if (Object.keys(targets).length === 0) return undefined;
  const metadata = Buffer.from(
    JSON.stringify({
      downloadBaseUrl: `${origin}/install`,
      webOrigin: origin,
      targets,
    }),
  ).toString("base64");
  const render = (template: string) => {
    if (template.split(WINDOWS_RELEASE_METADATA_MARKER).length !== 2) {
      throw new Error(
        `Installer template marker is missing: ${WINDOWS_RELEASE_METADATA_MARKER}`,
      );
    }
    return template.replace(WINDOWS_RELEASE_METADATA_MARKER, metadata);
  };
  return {
    install: render(release.windowsInstallerTemplate),
    uninstall: render(release.windowsUninstallerTemplate),
  };
};

const text = (status: number, body: string, method: string): Response =>
  new Response(method === "HEAD" ? null : `${body}\n`, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

const script = (
  body: string,
  method: string,
  contentType = "text/x-shellscript",
): Response =>
  new Response(method === "HEAD" ? null : body, {
    headers: {
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(body)),
      "content-type": `${contentType}; charset=utf-8`,
    },
  });

/**
 * Serves the Computer release this image ships, unauthenticated and read-only,
 * with the installers rendered once at startup. Without a release
 * every path answers 503; without WEB_PUBLIC_ORIGIN only the installers do.
 * The PowerShell scripts exist only when the image ships a Windows target.
 */
export function createComputerInstallRoute(
  installation:
    | {
        readonly release: ComputerRelease;
        readonly shell?: ShellInstallers;
        readonly windows?: WindowsInstallers;
      }
    | undefined,
): HttpRoute {
  const hasWindows = Object.keys(installation?.release.targets ?? {}).some(
    isWindowsTarget,
  );
  const files = new Map(
    Object.values(installation?.release.targets ?? {}).flatMap(
      ({ app, deps }) => [
        [app.file, app],
        [deps.file, deps],
      ],
    ),
  );
  return {
    prefixes: ["/install/"],
    fetch(request) {
      const method = request.method;
      if (method !== "GET" && method !== "HEAD") {
        return new Response(null, {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      if (!installation) {
        return text(
          503,
          "This Agent Service image ships no Computer release (release.json is missing).",
          method,
        );
      }
      // The raw path: encoded separators never match a name below.
      const pathname = new URL(request.url).pathname;
      // irm decodes text/plain as UTF-8 and iex runs it.
      const scripts = new Map<string, readonly [string | undefined, string?]>([
        ["/install/linger-computer.sh", [installation.shell?.install]],
        [
          "/install/uninstall-linger-computer.sh",
          [installation.shell?.uninstall],
        ],
        ...(hasWindows
          ? ([
              [
                "/install/linger-computer.ps1",
                [installation.windows?.install, "text/plain"],
              ],
              [
                "/install/uninstall-linger-computer.ps1",
                [installation.windows?.uninstall, "text/plain"],
              ],
            ] as const)
          : []),
      ]);
      const served = scripts.get(pathname);
      if (served) {
        const [body, contentType] = served;
        return body === undefined
          ? text(
              503,
              "WEB_PUBLIC_ORIGIN is not configured for this Agent Service.",
              method,
            )
          : script(body, method, contentType);
      }
      const name = pathname.startsWith("/install/files/")
        ? pathname.slice("/install/files/".length)
        : "";
      const archive = files.get(name);
      if (!archive) return new Response(null, { status: 404 });
      return new Response(
        method === "HEAD"
          ? null
          : (Readable.toWeb(
              createReadStream(
                path.join(installation.release.root, "files", archive.file),
              ),
            ) as ReadableStream),
        {
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "content-length": String(archive.size),
            "content-type": "application/gzip",
          },
        },
      );
    },
  };
}
