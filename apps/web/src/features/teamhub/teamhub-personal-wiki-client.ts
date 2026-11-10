import type { TeamHubApi } from "./teamhub-api";
import type { TeamHubClient } from "./teamhub-client";

export function createTeamHubPersonalWikiClient(
  api: TeamHubApi,
): Pick<TeamHubClient, "getPersonalKnowledgeGraphVisualization"> {
  return {
    getPersonalKnowledgeGraphVisualization: async (tenantId) => {
      const { response } = await api.GET(
        "/v0/tenants/{tenantId}/personal-wiki/graph",
        { params: { path: { tenantId } }, parseAs: "stream" },
      );
      return readBoundedText(response, 16 * 1024 * 1024);
    },
  };
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error("TeamHub text response exceeded its byte limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new Error("TeamHub text response exceeded its byte limit.");
  }
  return new TextDecoder().decode(bytes);
}
