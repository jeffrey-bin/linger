import { describe, expect, it } from "vitest";

import {
  profileSourcePolicy,
  profileSourceSubmitLabel,
} from "./profile-source-policy";

describe("profile source policy", () => {
  it("adds fixed sources immediately after an explicit profile action", () => {
    expect(profileSourcePolicy("gmail").selection).toBe("fixed");
    expect(profileSourcePolicy("outlook").selection).toBe("fixed");
  });

  it("distinguishes optional GitHub repositories from required choices", () => {
    expect(profileSourcePolicy("github").selection).toBe("optional");
    expect(profileSourcePolicy("google_calendar").selection).toBe("required");
    expect(profileSourcePolicy("notion").selection).toBe("required");
    expect(profileSourcePolicy("facebook").selection).toBe("unsupported");
  });

  it("names the submitted result instead of exposing a generic update command", () => {
    expect(profileSourceSubmitLabel("github", 0)).toBe("Add GitHub profile");
    expect(profileSourceSubmitLabel("github", 3)).toBe(
      "Add GitHub profile + 3 repositories",
    );
    expect(profileSourceSubmitLabel("google_calendar", 2)).toBe(
      "Add 2 calendars",
    );
    expect(profileSourceSubmitLabel("notion", 0)).toBe("Add 0 Notion items");
  });
});
