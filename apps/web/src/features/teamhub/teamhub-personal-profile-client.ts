import type {
  TeamHubPersonalProfile,
  TeamHubPersonalProfileGeneration,
  TeamHubPersonalProfileGenerationCreateInput,
  TeamHubPersonalProfileGenerationList,
  TeamHubPersonalInsightList,
  TeamHubPersonalProfileReplaceInput,
  TeamHubPersonalProfileRevision,
} from "./teamhub-types";
import {
  teamHubData as data,
  teamHubDone as done,
  type TeamHubApi,
} from "./teamhub-api";

export interface TeamHubPersonalProfileClient {
  getPersonalProfile(tenantId: string): Promise<TeamHubPersonalProfile>;
  replacePersonalProfile(
    tenantId: string,
    input: TeamHubPersonalProfileReplaceInput,
  ): Promise<TeamHubPersonalProfileRevision>;
  listPersonalProfileGenerations(
    tenantId: string,
  ): Promise<TeamHubPersonalProfileGenerationList>;
  createPersonalProfileGeneration(
    tenantId: string,
    input: TeamHubPersonalProfileGenerationCreateInput,
  ): Promise<TeamHubPersonalProfileGeneration>;
  listPersonalInsights(tenantId: string): Promise<TeamHubPersonalInsightList>;
  deletePersonalInsight(tenantId: string, insightId: string): Promise<void>;
}

export function createHttpTeamHubPersonalProfileClient(
  api: TeamHubApi,
): TeamHubPersonalProfileClient {
  const tenant = (tenantId: string) => ({ path: { tenantId } });
  return {
    getPersonalProfile: (tenantId) =>
      data(
        api.GET("/v0/tenants/{tenantId}/personal-profile", {
          params: tenant(tenantId),
        }),
      ),
    replacePersonalProfile: (tenantId, body) =>
      data(
        api.POST("/v0/tenants/{tenantId}/personal-profile/revisions", {
          params: tenant(tenantId),
          body,
        }),
      ),
    listPersonalProfileGenerations: (tenantId) =>
      data(
        api.GET("/v0/tenants/{tenantId}/personal-profile-generations", {
          params: tenant(tenantId),
        }),
      ),
    createPersonalProfileGeneration: (tenantId, body) =>
      data(
        api.POST("/v0/tenants/{tenantId}/personal-profile-generations", {
          params: { ...tenant(tenantId) },
          body,
        }),
      ),
    listPersonalInsights: (tenantId) =>
      data(
        api.GET("/v0/tenants/{tenantId}/personal-insights", {
          params: tenant(tenantId),
        }),
      ),
    deletePersonalInsight: (tenantId, personalInsightId) =>
      done(
        api.DELETE(
          "/v0/tenants/{tenantId}/personal-insights/{personalInsightId}",
          { params: { path: { tenantId, personalInsightId } } },
        ),
      ),
  };
}
