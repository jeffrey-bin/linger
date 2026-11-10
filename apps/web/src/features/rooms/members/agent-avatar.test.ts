// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_AVATAR_KEYS,
  AGENT_FIGURE_NAMES,
  agentAvatarAppearance,
  figureKey,
  imageKey,
  randomAgentAvatarKey,
  resolveAgentAvatarKey,
  storeAgentAvatarKey,
} from "./agent-avatar";

describe("Agent avatar persistence", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createTestStorage(),
    });
  });

  it("resolves a created Agent to its stored avatar key", () => {
    storeAgentAvatarKey("actor-release-partner", "figure:koala:9E964A");

    expect(
      resolveAgentAvatarKey({
        actorId: "actor-release-partner",
        name: "Release Partner",
      }),
    ).toBe("figure:koala:9E964A");
  });

  it("prefers TeamHub's record over this browser's last choice", () => {
    storeAgentAvatarKey("actor-shared", "figure:koala:9E964A");
    expect(
      resolveAgentAvatarKey({
        actorId: "actor-shared",
        name: "Shared",
        storedKey: "image:FFFFFF",
      }),
    ).toBe("image:FFFFFF");
  });
});

describe("Agent avatar appearance", () => {
  it("pairs every character with the background it was drawn on", () => {
    expect(AGENT_AVATAR_KEYS).toHaveLength(150);
    expect(new Set(AGENT_FIGURE_NAMES).size).toBe(150);
    expect(agentAvatarAppearance(figureKey("hen"))).toEqual({
      color: "#523568",
      figure: "hen",
      kind: "figure",
    });
  });

  it("keeps the character when the palette recolors its background", () => {
    expect(agentAvatarAppearance(figureKey("chipmunk", "#123abc"))).toEqual({
      color: "#123ABC",
      figure: "chipmunk",
      kind: "figure",
    });
  });

  it("reads an uploaded-image key as its background color", () => {
    expect(agentAvatarAppearance(imageKey("#12ab34"))).toMatchObject({
      color: "#12AB34",
      kind: "image",
    });
  });

  it("draws new Agents from the default pairings", () => {
    for (let draw = 0; draw < 20; draw += 1) {
      expect(AGENT_AVATAR_KEYS).toContain(randomAgentAvatarKey());
    }
  });
});

function createTestStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
