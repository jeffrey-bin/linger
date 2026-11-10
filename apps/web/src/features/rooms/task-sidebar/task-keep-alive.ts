export function selectMountedTaskTabs(input: {
  openTabIds: string[];
  activeTabId: string | null;
  lastActivatedAt: Record<string, number>;
  windowSize: number;
}): string[] {
  if (!input.activeTabId) return [];
  const others = input.openTabIds
    .filter((id) => id !== input.activeTabId)
    .sort(
      (a, b) =>
        (input.lastActivatedAt[b] ?? 0) - (input.lastActivatedAt[a] ?? 0),
    );
  return [input.activeTabId, ...others].slice(0, input.windowSize);
}
