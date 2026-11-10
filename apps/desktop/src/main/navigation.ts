// Pure navigation and permission policy for the remote SPA window,
// kept free of Electron imports so it is unit tested.

import { isIP } from "node:net";

export const OFFLINE_ORIGIN = "app://offline";
// The local title bar page.
export const SHELL_ORIGIN = "app://shell";

export const sameOrigin = (url: string, serverUrl: string): boolean => {
  try {
    return new URL(url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
};

export type NavigationDecision = "allow" | "external" | "deny";

// App pages are reachable only from app pages: the server's pages must not
// open app://offline/connect, which repoints the app to another server.
export const navigationDecision = (
  url: string,
  serverUrl: string | undefined,
  fromUrl?: string,
): NavigationDecision => {
  if (url.startsWith(`${OFFLINE_ORIGIN}/`))
    return fromUrl?.startsWith(`${OFFLINE_ORIGIN}/`) ? "allow" : "deny";
  if (serverUrl && sameOrigin(url, serverUrl)) return "allow";
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? "external" : "deny";
  } catch {
    return "deny";
  }
};

export const permissionAllowed = (
  permission: string,
  details: { mediaTypes?: readonly string[]; requestingUrl?: string },
  serverUrl: string | undefined,
): boolean => {
  if (!serverUrl || !details.requestingUrl) return false;
  if (!sameOrigin(details.requestingUrl, serverUrl)) return false;
  if (permission === "notifications") return true;
  if (permission === "media") {
    const types = details.mediaTypes ?? [];
    return types.length > 0 && types.every((t) => t === "audio");
  }
  return false;
};

// Hosts where plain HTTP is tolerated: loopback and private networks.
export const isLocalNetworkHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (isIP(host) === 6) {
    return (
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80")
    );
  }
  return false;
};

// Only https servers, or http on loopback and private networks: enrollment sends the session cookie and receives the
// computer credential from this address. It comes from the user on
// app://offline.
export const parseServerUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLocalNetworkHost(url.hostname))
    )
      return undefined;
    if (url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};

// A page opened in the app's preview panel is framed by the app. Many sites
// refuse every frame (X-Frame-Options, CSP frame-ancestors) and the panel
// stays blank, so the window drops those two rules for its own frames. The
// panel's frame is sandboxed and cannot navigate or script the app.
export const framableHeaders = (
  headers: Record<string, string[]>,
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, values]) => {
      const lower = name.toLowerCase();
      if (lower === "x-frame-options") return [];
      if (lower !== "content-security-policy") return [[name, values]];
      const policies = values
        .map((value) =>
          value
            .split(";")
            .filter(
              (directive) =>
                directive.trim().split(/\s+/)[0]?.toLowerCase() !==
                "frame-ancestors",
            )
            .join(";")
            .trim(),
        )
        .filter((value) => value.replace(/;/g, "").trim());
      return policies.length ? [[name, policies]] : [];
    }),
  );
