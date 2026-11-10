import { beforeEach, describe, expect, it } from "vitest";

import {
  closePanelTab,
  ensureDefaultAgentInfoTab,
  movePanelTab,
  openPanelTab,
  readPanelTabState,
  retargetAgentInfoTab,
} from "./panel-tab-store";
import { panelTabKey } from "./panel-tab-types";

const scope = {
  accountId: "account-1",
  tenantId: "tenant-1",
  roomId: "room-1",
};

describe("panel tab store", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return store.size;
        },
        clear() {
          store.clear();
        },
        getItem(key: string) {
          return store.get(key) ?? null;
        },
        key(index: number) {
          return [...store.keys()][index] ?? null;
        },
        removeItem(key: string) {
          store.delete(key);
        },
        setItem(key: string, value: string) {
          store.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it("deduplicates Task cards by Task identity and restores the Task ID", () => {
    openPanelTab(scope, {
      kind: "taskActivity",
      taskId: "task-a",
      title: "Task created",
    });
    openPanelTab(scope, {
      kind: "taskActivity",
      taskId: "task-a",
      title: "Task completed",
    });
    const state = readPanelTabState(scope);
    expect(state.openTabIds).toEqual(["taskActivity:task-a"]);
    expect(state.tabs["taskActivity:task-a"]?.taskId).toBe("task-a");
    expect(() => panelTabKey("taskActivity", {})).toThrow("requires taskId");
  });

  it("defaults an empty Room to Agent Info without replacing an open Thread", () => {
    const agent = { id: "agent-1", display_name: "Sinclair" };
    expect(ensureDefaultAgentInfoTab(scope).openTabIds).toEqual([]);
    const state = ensureDefaultAgentInfoTab(scope, agent);
    expect(state.activeTabId).toBe("agentInfo:agent-1");
    expect(ensureDefaultAgentInfoTab(scope, agent).openTabIds).toHaveLength(1);
    const thread = openPanelTab(scope, {
      kind: "thread",
      anchorMessageId: "message-1",
      title: "Question",
    });
    expect(ensureDefaultAgentInfoTab(scope, agent)).toEqual(thread);
  });

  it("remembers an explicit Agent Info close even after the undo stack rolls over", () => {
    const agent = { id: "agent-1", display_name: "Sinclair" };
    const state = ensureDefaultAgentInfoTab(scope, agent);
    closePanelTab(scope, state.activeTabId!);
    for (let i = 0; i < 6; i += 1) {
      const document = openPanelTab(scope, {
        kind: "file",
        documentId: `doc-${i}`,
        title: "Document",
      });
      closePanelTab(scope, document.activeTabId!);
    }
    expect(
      readPanelTabState(scope).closedStack.some(
        (tab) => tab.kind === "agentInfo",
      ),
    ).toBe(false);
    expect(ensureDefaultAgentInfoTab(scope, agent).openTabIds).toEqual([]);
    expect(
      ensureDefaultAgentInfoTab({ ...scope, roomId: "another-room" }, agent)
        .activeTabId,
    ).toBe("agentInfo:agent-1");
    expect(
      openPanelTab(scope, {
        kind: "agentInfo",
        actorId: agent.id,
        title: "Agent · Sinclair",
      }).activeTabId,
    ).toBe("agentInfo:agent-1");
  });

  it("persists tab order without changing selection or activation history", () => {
    openPanelTab(scope, { kind: "file", documentId: "a", title: "A" });
    openPanelTab(scope, { kind: "file", documentId: "b", title: "B" });
    const before = openPanelTab(scope, {
      kind: "file",
      documentId: "c",
      title: "C",
    });
    const [a, b, c] = before.openTabIds;
    movePanelTab(scope, a!, c!);
    const after = readPanelTabState(scope);
    expect(after.openTabIds).toEqual([b, c, a]);
    expect(after.activeTabId).toBe(before.activeTabId);
    expect(after.tabs).toEqual(before.tabs);
    expect(movePanelTab(scope, "missing", a!)).toEqual(after);
    expect(movePanelTab(scope, a!, a!)).toEqual(after);
    expect(movePanelTab(scope, a!, b!).openTabIds).toEqual([a, b, c]);
  });

  it("dedupes by kind + anchor and activates on re-open", () => {
    openPanelTab(scope, {
      kind: "thread",
      anchorMessageId: "msg-1",
      title: "A",
    });
    openPanelTab(scope, {
      kind: "roomInfo",
      anchorMessageId: "msg-1",
      title: "A",
    });
    openPanelTab(scope, {
      kind: "thread",
      anchorMessageId: "msg-1",
      title: "A",
    });

    const state = readPanelTabState(scope);
    expect(state.openTabIds).toHaveLength(2);
    expect(state.tabs[state.activeTabId!]?.kind).toBe("thread");
  });

  it("opens one tab per Document", () => {
    openPanelTab(scope, {
      kind: "file",
      documentId: "doc-1",
      title: "a.md",
    });
    openPanelTab(scope, {
      kind: "file",
      documentId: "doc-2",
      title: "b.csv",
    });
    openPanelTab(scope, {
      kind: "file",
      documentId: "doc-1",
      title: "a.md",
    });
    const state = readPanelTabState(scope);
    expect(state.openTabIds).toHaveLength(2);
    expect(state.activeTabId).toBe(
      panelTabKey("file", { documentId: "doc-1" }),
    );
  });

  it("opens one Agent Info tab per Agent and restores its identity", () => {
    openPanelTab(scope, {
      kind: "agentInfo",
      actorId: "agent-1",
      title: "Agent · Codex",
    });
    openPanelTab(scope, {
      kind: "agentInfo",
      actorId: "agent-2",
      title: "Agent · Pollen",
    });
    openPanelTab(scope, {
      kind: "agentInfo",
      actorId: "agent-1",
      anchorMessageId: "message-1",
      title: "Agent · Codex",
    });

    const state = readPanelTabState(scope);
    expect(state.openTabIds).toHaveLength(2);
    expect(state.activeTabId).toBe(
      panelTabKey("agentInfo", { actorId: "agent-1" }),
    );
    expect(state.tabs[state.activeTabId!]?.actorId).toBe("agent-1");
    expect(state.tabs[state.activeTabId!]?.anchorMessageId).toBe("message-1");
    expect(state.tabs[state.activeTabId!]?.activityRunStatusId).toBeUndefined();

    const profileState = openPanelTab(scope, {
      kind: "agentInfo",
      actorId: "agent-1",
      title: "Agent · Codex",
    });
    expect(profileState.openTabIds).toHaveLength(2);
    expect(
      profileState.tabs[profileState.activeTabId!]?.anchorMessageId,
    ).toBeUndefined();
  });

  it("keeps the selected Run through title refresh and clears it for another activity", () => {
    openPanelTab(scope, {
      kind: "agentInfo",
      actorId: "agent-1",
      activityRunId: "run-live",
      activityRoomId: "thread-live",
      title: "Agent",
    });
    const refreshed = openPanelTab(scope, {
      kind: "agentInfo",
      actorId: "agent-1",
      title: "Codex",
      preserveAgentInfoActivity: true,
    });
    expect(refreshed.tabs[refreshed.activeTabId!]?.activityRunId).toBe(
      "run-live",
    );
    expect(refreshed.tabs[refreshed.activeTabId!]?.activityRoomId).toBe(
      "thread-live",
    );
    const next = openPanelTab(scope, {
      kind: "agentInfo",
      actorId: "agent-1",
      activityRunStatusId: "other-run-status",
      title: "Agent",
    });
    expect(next.tabs[next.activeTabId!]?.activityRunId).toBeUndefined();
    expect(next.tabs[next.activeTabId!]?.activityRoomId).toBeUndefined();
  });

  it("stores live activity Run Status identity on the Agent Info tab", () => {
    const state = openPanelTab(scope, {
      activityRunStatusId: "run-status-live",
      actorId: "agent-1",
      kind: "agentInfo",
      title: "Agent · Codex",
    });

    expect(state.openTabIds).toHaveLength(1);
    expect(state.tabs[state.activeTabId!]?.kind).toBe("agentInfo");
    expect(state.tabs[state.activeTabId!]?.activityRunStatusId).toBe(
      "run-status-live",
    );
    expect(
      state.tabs[panelTabKey("agentActivity", { actorId: "agent-1" })],
    ).toBeUndefined();
  });

  it("keeps nested Agent Info activity when the title is only refreshed", () => {
    openPanelTab(scope, {
      activityRunStatusId: "run-status-live",
      actorId: "agent-1",
      kind: "agentInfo",
      title: "Agent · New Agent",
    });

    const next = openPanelTab(scope, {
      actorId: "agent-1",
      kind: "agentInfo",
      preserveAgentInfoActivity: true,
      title: "Agent · Slide Expert",
    });

    expect(next.openTabIds).toHaveLength(1);
    expect(next.tabs[next.activeTabId!]?.title).toBe("Agent · Slide Expert");
    expect(next.tabs[next.activeTabId!]?.activityRunStatusId).toBe(
      "run-status-live",
    );
  });

  it("opens Agent live activity as its own tab without replacing Agent Info", () => {
    openPanelTab(scope, {
      actorId: "previous-agent",
      kind: "agentInfo",
      title: "Agent · Slide Expert",
    });
    openPanelTab(scope, {
      activityRunStatusId: "run-status-live",
      actorId: "previous-agent",
      kind: "agentActivity",
      title: "Agent activity",
    });

    const state = readPanelTabState(scope);
    expect(state.openTabIds).toHaveLength(2);
    expect(state.tabs[state.activeTabId!]?.kind).toBe("agentActivity");
    expect(state.tabs[state.activeTabId!]?.activityRunStatusId).toBe(
      "run-status-live",
    );
    expect(
      state.tabs[panelTabKey("agentInfo", { actorId: "previous-agent" })]
        ?.activityRunStatusId,
    ).toBeUndefined();

    const restored = openPanelTab(scope, {
      actorId: "previous-agent",
      kind: "agentInfo",
      preserveAgentInfoActivity: true,
      title: "Agent · Slide Expert",
    });
    expect(restored.tabs[restored.activeTabId!]?.kind).toBe("agentInfo");
    expect(
      restored.tabs[panelTabKey("agentActivity", { actorId: "previous-agent" })]
        ?.activityRunStatusId,
    ).toBe("run-status-live");
  });

  it("keeps the Agent Activity tab when Agent Info is only refreshed for a new title", () => {
    openPanelTab(scope, {
      actorId: "previous-agent",
      kind: "agentInfo",
      title: "Agent · New Agent",
    });
    openPanelTab(scope, {
      activityRunStatusId: "run-status-live",
      actorId: "previous-agent",
      kind: "agentActivity",
      title: "Agent activity",
    });

    const next = openPanelTab(scope, {
      actorId: "previous-agent",
      kind: "agentInfo",
      preserveAgentInfoActivity: true,
      title: "Agent · Slide Expert",
    });

    expect(next.tabs[next.activeTabId!]?.title).toBe("Agent · Slide Expert");
    expect(
      next.tabs[panelTabKey("agentActivity", { actorId: "previous-agent" })]
        ?.activityRunStatusId,
    ).toBe("run-status-live");
  });

  it("closes leftover previous peer activity when retargeting Agent Info to the created Agent", () => {
    openPanelTab(scope, {
      actorId: "previous-agent",
      kind: "agentInfo",
      title: "Agent · New Agent",
    });
    openPanelTab(scope, {
      activityRunStatusId: "run-status-live",
      actorId: "previous-agent",
      kind: "agentActivity",
      title: "New Agent activity",
    });

    const next = retargetAgentInfoTab(scope, "previous-agent", {
      display_name: "Slide Expert",
      id: "agent-created",
    });

    expect(next.tabs[next.activeTabId!]?.actorId).toBe("agent-created");
    expect(next.tabs[next.activeTabId!]?.kind).toBe("agentInfo");
    expect(next.tabs[next.activeTabId!]?.activityRunStatusId).toBeUndefined();
    expect(next.tabs[next.activeTabId!]?.title).toBe("Agent · Slide Expert");
    expect(next.openTabIds).not.toContain(
      panelTabKey("agentInfo", { actorId: "previous-agent" }),
    );
    expect(next.openTabIds).not.toContain(
      panelTabKey("agentActivity", { actorId: "previous-agent" }),
    );
  });

  it("updates the exact Version when reopening the same Document", () => {
    openPanelTab(scope, {
      kind: "file",
      documentId: "doc-1",
      title: "report.html",
      versionId: "version-1",
    });
    openPanelTab(scope, {
      kind: "file",
      documentId: "doc-1",
      title: "report.html",
      versionId: "version-2",
    });

    const state = readPanelTabState(scope);
    expect(state.openTabIds).toHaveLength(1);
    expect(state.tabs[state.activeTabId!]?.versionId).toBe("version-2");
  });

  it("clears the exact Version when reopening a Document without one", () => {
    openPanelTab(scope, {
      kind: "file",
      documentId: "doc-1",
      title: "report.html",
      versionId: "version-1",
    });
    openPanelTab(scope, {
      kind: "file",
      documentId: "doc-1",
      title: "report",
    });

    const state = readPanelTabState(scope);
    expect(state.openTabIds).toHaveLength(1);
    expect(state.tabs[state.activeTabId!]?.versionId).toBeUndefined();
  });

  it("activates the right neighbor when closing the active tab", () => {
    openPanelTab(scope, {
      kind: "thread",
      anchorMessageId: "msg-a",
      title: "A",
    });
    openPanelTab(scope, {
      kind: "thread",
      anchorMessageId: "msg-b",
      title: "B",
    });
    openPanelTab(scope, {
      kind: "thread",
      anchorMessageId: "msg-c",
      title: "C",
    });
    const mid = readPanelTabState(scope).openTabIds[1]!;
    openPanelTab(scope, {
      kind: "thread",
      anchorMessageId: "msg-b",
      title: "B",
    });
    closePanelTab(scope, mid);
    const state = readPanelTabState(scope);
    expect(state.tabs[state.activeTabId!]?.anchorMessageId).toBe("msg-c");
  });

  it("opens singleton collection tabs without an anchor", () => {
    openPanelTab(scope, { kind: "thread", title: "New Thread" });
    openPanelTab(scope, { kind: "file", title: "Files" });
    openPanelTab(scope, { kind: "thread", title: "New Thread" });

    const state = readPanelTabState(scope);
    expect(state.openTabIds).toHaveLength(2);
    expect(state.activeTabId).toBe(panelTabKey("thread", {}));
    expect(state.tabs[panelTabKey("file", {})]?.documentId).toBeUndefined();
  });

  it("opens the Figma launcher destinations as singleton tabs", () => {
    openPanelTab(scope, { kind: "roomInfo", title: "Room info" });
    openPanelTab(scope, { kind: "url", title: "URL" });
    openPanelTab(scope, { kind: "roomInfo", title: "Room info" });

    const state = readPanelTabState(scope);
    expect(state.openTabIds).toEqual(["roomInfo:current", "url:preview"]);
    expect(state.activeTabId).toBe("roomInfo:current");
  });
});
