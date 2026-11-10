export const teamHubDocumentsQueryKey = ["teamhub", "documents"] as const;

export function personalWikiDocumentsQueryKey(tenantId: string) {
  return [...teamHubDocumentsQueryKey, "personal-wiki", tenantId] as const;
}
