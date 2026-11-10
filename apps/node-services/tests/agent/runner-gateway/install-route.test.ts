import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startHttpHost, type HttpHost } from "../../../src/http-host.js";
import { loadComputerRelease } from "../../../src/agent/runner-gateway/computer-release.js";
import {
  createComputerInstallRoute,
  renderShellInstallers,
  renderWindowsInstallers,
  resolveInstallOrigin,
} from "../../../src/agent/runner-gateway/install-route.js";
import {
  installerTemplate,
  uninstallerTemplate,
  writeComputerRelease,
} from "./computer-release-fixture.js";

const hosts: HttpHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

const serve = async (
  root: string | undefined,
  origin: string | null = resolveInstallOrigin("https://app.example.test")!,
) => {
  const release = root ? await loadComputerRelease(root) : undefined;
  const host = await startHttpHost({ host: "127.0.0.1", port: 0 });
  hosts.push(host);
  host.mount(
    createComputerInstallRoute(
      release && {
        release,
        ...(origin
          ? {
              shell: renderShellInstallers(release, origin),
              windows: renderWindowsInstallers(release, origin),
            }
          : {}),
      },
    ),
  );
  host.finishStartup();
  return host;
};

/** A raw request: the path reaches the server exactly as written. */
const raw = (
  host: HttpHost,
  requestPath: string,
  method = "GET",
): Promise<{
  status: number;
  headers: Record<string, unknown>;
  body: Buffer;
}> =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port: host.port, path: requestPath, method },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });

describe("Computer install route", () => {
  it("serves listed archives byte-identically, with HEAD and immutable caching", async () => {
    const { root, archives } = await writeComputerRelease();
    const host = await serve(root);
    const expected = await readFile(
      path.join(root, "files", archives.app!.file),
    );
    const first = await raw(host, `/install/files/${archives.app!.file}`);
    const second = await raw(host, `/install/files/${archives.app!.file}?x=1`);
    expect(first.status).toBe(200);
    expect(first.body.equals(expected)).toBe(true);
    expect(second.body.equals(first.body)).toBe(true);
    expect(first.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(first.headers["content-length"]).toBe(String(expected.length));
    const head = await raw(
      host,
      `/install/files/${archives.app!.file}`,
      "HEAD",
    );
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(expected.length));
    expect(head.body.length).toBe(0);
  });

  it("keeps serving archives without WEB_PUBLIC_ORIGIN and answers 503 only for the scripts", async () => {
    const { root, archives } = await writeComputerRelease();
    const host = await serve(root, null);
    expect(
      (await raw(host, `/install/files/${archives.app!.file}`)).status,
    ).toBe(200);
    for (const requestPath of [
      "/install/linger-computer.sh",
      "/install/uninstall-linger-computer.sh",
    ]) {
      const response = await raw(host, requestPath);
      expect(response.status, requestPath).toBe(503);
      expect(response.body.toString()).toContain("WEB_PUBLIC_ORIGIN");
    }
  });

  it("answers 404 for names outside release.json and paths that try to escape files/", async () => {
    const { root, archives } = await writeComputerRelease();
    const host = await serve(root);
    for (const requestPath of [
      `/install/files/app-darwin-arm64-${"0".repeat(64)}.tar.gz`,
      "/install/files/release.json",
      "/install/files/..%2Frelease.json",
      "/install/files/%2e%2e/release.json",
      `/install/files/x%2F${archives.app!.file}`,
      `/install/files/${archives.app!.file.replace(".tar.gz", ".tar.gz%00")}`,
      "/install/files/../release.json",
      "/install/release.json",
      "/install/",
      "/install/latest.txt",
    ]) {
      expect((await raw(host, requestPath)).status, requestPath).toBe(404);
    }
    expect(
      (await raw(host, `/install/files/${archives.app!.file}`, "POST")).status,
    ).toBe(405);
  });

  it("answers 503 on every install path when the image ships no release", async () => {
    const host = await serve(undefined);
    for (const requestPath of [
      "/install/linger-computer.sh",
      "/install/uninstall-linger-computer.sh",
      `/install/files/app-linux-x64-${"0".repeat(64)}.tar.gz`,
    ]) {
      const response = await raw(host, requestPath);
      expect(response.status).toBe(503);
      expect(response.body.toString()).toContain("release.json is missing");
    }
  });

  it("renders both shell scripts with the origin and the installer with every target line from release.json", async () => {
    const { root, archives } = await writeComputerRelease();
    const host = await serve(root);
    const response = await raw(host, "/install/linger-computer.sh");
    expect(response.status).toBe(200);
    const lines = response.body.toString().split("\n");
    expect(lines).toContain(
      'web_origin="${LINGER_WEB_URL:-https://app.example.test}"',
    );
    expect(lines).toContain(
      `release_linux_x64="${archives.app!.sha256} ${archives.app!.size} ${archives.deps!.sha256} ${archives.deps!.size}"`,
    );
    for (const target of ["darwin_arm64", "darwin_x64", "linux_arm64"]) {
      expect(lines).toContain(`release_${target}=""`);
    }
    const uninstaller = await raw(
      host,
      "/install/uninstall-linger-computer.sh",
    );
    expect(uninstaller.body.toString().split("\n")).toContain(
      'web_origin="${LINGER_WEB_URL:-https://app.example.test}"',
    );
  });

  it("renders the PowerShell installers with this deployment's origin and Windows archives", async () => {
    const { root, targets } = await writeComputerRelease({
      targets: ["linux-x64", "win32-x64"],
    });
    const host = await serve(root);
    const metadataOf = (body: string) =>
      JSON.parse(
        Buffer.from(/\$m = '([^']+)'/u.exec(body)![1]!, "base64").toString(),
      ) as unknown;
    const install = await raw(host, "/install/linger-computer.ps1");
    expect(install.status).toBe(200);
    expect(install.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(install.body.toString()).toContain("Write-Host install");
    expect(metadataOf(install.body.toString())).toEqual({
      downloadBaseUrl: "https://app.example.test/install",
      webOrigin: "https://app.example.test",
      targets: { "win32-x64": targets["win32-x64"] },
    });
    const uninstall = await raw(host, "/install/uninstall-linger-computer.ps1");
    expect(uninstall.body.toString()).toContain("Write-Host uninstall");
    expect(metadataOf(uninstall.body.toString())).toEqual(
      metadataOf(install.body.toString()),
    );
    const windowsApp = targets["win32-x64"]!.app!.file;
    expect((await raw(host, `/install/files/${windowsApp}`)).status).toBe(200);
    // The bash installer has no Windows line to fill.
    expect(
      (await raw(host, "/install/linger-computer.sh")).body.toString(),
    ).not.toContain("win32");
  });

  it("serves no PowerShell installer when the image ships no Windows target", async () => {
    const { root } = await writeComputerRelease();
    const host = await serve(root);
    for (const requestPath of [
      "/install/linger-computer.ps1",
      "/install/uninstall-linger-computer.ps1",
    ]) {
      expect((await raw(host, requestPath)).status, requestPath).toBe(404);
    }
    const windowsOnly = await writeComputerRelease({ targets: ["win32-x64"] });
    const unconfigured = await serve(windowsOnly.root, null);
    expect(
      (await raw(unconfigured, "/install/linger-computer.ps1")).status,
    ).toBe(503);
  });

  it("fails rendering a template with a missing marker", () => {
    expect(() =>
      renderShellInstallers(
        {
          installerTemplate: installerTemplate.replace(
            'release_linux_arm64=""\n',
            "",
          ),
          uninstallerTemplate,
          targets: {},
        },
        "https://app.example.test",
      ),
    ).toThrow("marker is missing");
  });

  it("accepts HTTPS and HTTP origins", async () => {
    expect(resolveInstallOrigin("https://app.example.test")).toBe(
      "https://app.example.test",
    );
    expect(resolveInstallOrigin("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    const development = resolveInstallOrigin("http://10.0.0.5:31037");
    expect(development).toBe("http://10.0.0.5:31037");
    for (const value of [
      "https://app.example.test/path",
      "ftp://app.example.test",
      "not a url",
    ]) {
      expect(() => resolveInstallOrigin(value)).toThrow(
        /WEB_PUBLIC_ORIGIN must be/,
      );
    }
    expect(resolveInstallOrigin(undefined)).toBeUndefined();

    const { root } = await writeComputerRelease();
    const host = await serve(root, development);
    const lines = (await raw(host, "/install/linger-computer.sh")).body
      .toString()
      .split("\n");
    expect(lines).toContain(
      'web_origin="${LINGER_WEB_URL:-http://10.0.0.5:31037}"',
    );
  });
});
