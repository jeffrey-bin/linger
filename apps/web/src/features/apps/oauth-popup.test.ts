// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { openOAuthPopup, openOAuthUrl } from "./oauth-popup";

describe("OAuth popup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens the Connect Link directly in a named 560x720 popup", () => {
    const popup = { closed: false, focus: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    expect(openOAuthPopup("https://connect.example.test/oauth")).toBe(popup);
    expect(window.open).toHaveBeenCalledWith(
      "https://connect.example.test/oauth",
      "linger_composio_oauth",
      expect.stringMatching(
        /popup=yes,width=560,height=720,left=\d+,top=\d+,resizable=yes,scrollbars=yes/,
      ),
    );
  });

  it("reports a blocked popup without treating it as authorization failure", () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    expect(openOAuthUrl("https://connect.example.test/oauth")).toBe(false);
  });
});
