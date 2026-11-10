export function dashboardWorkItemPath(tenantId: string, workItemId: string) {
  return `/t/${encodeURIComponent(tenantId)}/dashboard/${encodeURIComponent(workItemId)}`;
}
