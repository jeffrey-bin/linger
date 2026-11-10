/** TeamHub's single-host address; split deployments set TEAMHUB_BASE_URL. */
const DEFAULT_TEAMHUB_BASE_URL = "http://127.0.0.1:8080";

export function teamHubBaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.TEAMHUB_BASE_URL?.trim() || DEFAULT_TEAMHUB_BASE_URL;
}
