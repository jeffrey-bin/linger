import { expect, it, vi } from "vitest";
import { usesBrowserOAuth } from "./runtime-login-mode.js";
it("uses browser callbacks on native Mac and Windows only", () => {
  expect(usesBrowserOAuth("darwin")).toBe(true);
  expect(usesBrowserOAuth("win32")).toBe(true);
  vi.stubEnv("LINGER_WINDOWS_HOST", "1");
  vi.stubEnv("WSL_DISTRO_NAME", "Linger");
  try {
    expect(usesBrowserOAuth("linux")).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});
