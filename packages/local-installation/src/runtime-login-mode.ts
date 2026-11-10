/** Native desktop platforms can open provider OAuth callbacks in the host browser. */
export function usesBrowserOAuth(platform: NodeJS.Platform = process.platform) {
  return platform === "darwin" || platform === "win32";
}
