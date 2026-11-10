import {
  PANEL_CLOSED_STACK_CAP,
  PANEL_TAB_CAP,
  panelTabKey,
  type PanelTab,
  type PanelTabKind,
  type PanelTabScope,
  type PanelTabState,
} from "./panel-tab-types";

const prefix = "linger.panel-tabs.v3:";

function key(scope: PanelTabScope) {
  return `${prefix}${[scope.accountId, scope.tenantId, scope.roomId]
    .map(encodeURIComponent)
    .join(":")}`;
}

function emptyState(): PanelTabState {
  return {
    openTabIds: [],
    activeTabId: null,
    tabs: {},
    closedStack: [],
    lastEvicted: null,
  };
}

function write(scope: PanelTabScope, state: PanelTabState) {
  try {
    globalThis.localStorage?.setItem(key(scope), JSON.stringify(state));
  } catch {
    // session-only fallback: caller may keep React state
  }
}

export function readPanelTabState(scope: PanelTabScope): PanelTabState {
  try {
    const raw = globalThis.localStorage?.getItem(key(scope));
    if (raw) return { ...emptyState(), ...JSON.parse(raw) } as PanelTabState;
  } catch {
    return emptyState();
  }
  return emptyState();
}

export function openPanelTab(
  scope: PanelTabScope,
  input: {
    kind: PanelTabKind;
    activityRunStatusId?: string;
    activityRunId?: string;
    activityRoomId?: string;
    taskId?: string;
    actorId?: string;
    anchorMessageId?: string;
    documentId?: string;
    preserveAgentInfoActivity?: boolean;
    previewUrl?: string;
    title: string;
    versionId?: string;
    previewCurrentVersion?: boolean;
  },
) {
  const state = readPanelTabState(scope);
  const now = Date.now();
  const ownedByAgent =
    input.kind === "agentInfo" || input.kind === "agentActivity";
  const id = panelTabKey(input.kind, {
    actorId: input.actorId,
    anchorMessageId: input.anchorMessageId,
    documentId: input.documentId,
    taskId: input.taskId,
  });
  const existing = state.tabs[id];
  const storesActivity =
    input.kind === "agentInfo" || input.kind === "agentActivity";
  const preserveActivity =
    storesActivity && Boolean(input.preserveAgentInfoActivity);
  if (existing) {
    state.tabs[id] = {
      ...existing,
      activityRoomId: storesActivity
        ? (input.activityRoomId ??
          (preserveActivity ? existing.activityRoomId : undefined))
        : undefined,
      activityRunId: storesActivity
        ? (input.activityRunId ??
          (preserveActivity ? existing.activityRunId : undefined))
        : undefined,
      activityRunStatusId: storesActivity
        ? (input.activityRunStatusId ??
          (preserveActivity ? existing.activityRunStatusId : undefined))
        : undefined,
      actorId: ownedByAgent ? input.actorId : undefined,
      taskId: input.kind === "taskActivity" ? input.taskId : undefined,
      anchorMessageId: storesActivity
        ? (input.anchorMessageId ??
          (preserveActivity ? existing.anchorMessageId : undefined))
        : input.kind === "file"
          ? undefined
          : input.anchorMessageId,
      previewUrl: input.previewUrl ?? existing.previewUrl,
      title: input.title || existing.title,
      versionId:
        input.kind === "file"
          ? input.versionId
          : (input.versionId ?? existing.versionId),
      previewCurrentVersion:
        input.kind === "file" ? input.previewCurrentVersion : undefined,
      lastActivatedAt: now,
    };
  } else {
    const tab: PanelTab = {
      id,
      kind: input.kind,
      activityRunId: storesActivity ? input.activityRunId : undefined,
      activityRoomId: storesActivity ? input.activityRoomId : undefined,
      activityRunStatusId: storesActivity
        ? input.activityRunStatusId
        : undefined,
      actorId: ownedByAgent ? input.actorId : undefined,
      taskId: input.kind === "taskActivity" ? input.taskId : undefined,
      anchorMessageId:
        input.kind === "file" ? undefined : input.anchorMessageId,
      documentId: input.kind === "file" ? input.documentId : undefined,
      versionId: input.kind === "file" ? input.versionId : undefined,
      previewCurrentVersion:
        input.kind === "file" ? input.previewCurrentVersion : undefined,
      previewUrl: input.previewUrl,
      title: input.title,
      lastActivatedAt: now,
    };
    state.openTabIds.push(id);
    state.tabs[id] = tab;
  }
  state.activeTabId = id;
  state.lastEvicted = null;

  while (state.openTabIds.length > PANEL_TAB_CAP) {
    const lru = [...state.openTabIds].sort(
      (a, b) =>
        (state.tabs[a]?.lastActivatedAt ?? 0) -
        (state.tabs[b]?.lastActivatedAt ?? 0),
    )[0]!;
    if (lru === state.activeTabId) break;
    const tab = state.tabs[lru];
    state.openTabIds = state.openTabIds.filter((openId) => openId !== lru);
    delete state.tabs[lru];
    if (tab) state.lastEvicted = tab;
  }

  write(scope, state);
  return state;
}

export function ensureDefaultAgentInfoTab(
  scope: PanelTabScope,
  agent?: { id: string; display_name: string },
) {
  const state = readPanelTabState(scope);
  if (!agent || state.openTabIds.length || state.defaultAgentInfoDismissed) {
    return state;
  }
  return openPanelTab(scope, {
    kind: "agentInfo",
    actorId: agent.id,
    title: `Agent · ${agent.display_name}`,
  });
}

export function retargetAgentInfoTab(
  scope: PanelTabScope,
  fromActorId: string,
  toPeer: { display_name: string; id: string },
) {
  const fromInfoId = panelTabKey("agentInfo", { actorId: fromActorId });
  const fromActivityId = panelTabKey("agentActivity", { actorId: fromActorId });
  const current = readPanelTabState(scope);
  if (current.tabs[fromInfoId]) closePanelTab(scope, fromInfoId);
  if (current.tabs[fromActivityId]) closePanelTab(scope, fromActivityId);
  return openPanelTab(scope, {
    actorId: toPeer.id,
    kind: "agentInfo",
    title: `Agent · ${toPeer.display_name}`,
  });
}

export function closePanelTab(scope: PanelTabScope, tabId: string) {
  const state = readPanelTabState(scope);
  const closedIndex = state.openTabIds.indexOf(tabId);
  const tab = state.tabs[tabId];
  if (tab?.kind === "agentInfo") state.defaultAgentInfoDismissed = true;
  state.openTabIds = state.openTabIds.filter((id) => id !== tabId);
  delete state.tabs[tabId];
  if (tab) {
    state.closedStack = [tab, ...state.closedStack].slice(
      0,
      PANEL_CLOSED_STACK_CAP,
    );
  }
  if (state.activeTabId === tabId) {
    state.activeTabId =
      (closedIndex >= 0
        ? (state.openTabIds[closedIndex] ?? state.openTabIds[closedIndex - 1])
        : state.openTabIds[0]) ?? null;
  }
  write(scope, state);
  return state;
}

export function setActivePanelTab(scope: PanelTabScope, tabId: string) {
  const state = readPanelTabState(scope);
  if (!state.openTabIds.includes(tabId)) return state;
  state.activeTabId = tabId;
  state.tabs[tabId] = {
    ...state.tabs[tabId]!,
    lastActivatedAt: Date.now(),
  };
  write(scope, state);
  return state;
}

export function restoreClosedPanelTab(scope: PanelTabScope) {
  const state = readPanelTabState(scope);
  const tab = state.closedStack[0];
  if (!tab) return state;
  state.closedStack = state.closedStack.slice(1);
  write(scope, state);
  return openPanelTab(scope, {
    kind: tab.kind,
    activityRunStatusId: tab.activityRunStatusId,
    activityRunId: tab.activityRunId,
    activityRoomId: tab.activityRoomId,
    actorId: tab.actorId,
    anchorMessageId: tab.anchorMessageId,
    documentId: tab.documentId,
    title: tab.title,
    versionId: tab.versionId,
  });
}

export function clearActivePanelTab(scope: PanelTabScope) {
  const state = readPanelTabState(scope);
  state.activeTabId = null;
  write(scope, state);
  return state;
}

export function openFilePanelTab(
  scope: PanelTabScope,
  document: { current_version?: { id?: string }; id: string; title: string },
) {
  return openPanelTab(scope, {
    kind: "file",
    documentId: document.id,
    title: document.title,
    versionId: document.current_version?.id,
  });
}

export function movePanelTab(
  scope: PanelTabScope,
  tabId: string,
  targetId: string,
) {
  const state = readPanelTabState(scope);
  const from = state.openTabIds.indexOf(tabId);
  const to = state.openTabIds.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return state;
  state.openTabIds.splice(from, 1);
  state.openTabIds.splice(to, 0, tabId);
  write(scope, state);
  return state;
}
