export interface ManagedToolsRuntime {
  root: string;
  binDirectory: string;
  bootstrapBin: string;
  readOnlyRoots: string[];
  path: string;
}
export function prepareManagedToolsRuntime(
  environment?: NodeJS.ProcessEnv,
  options?: { ensureInstalled?: boolean },
): Promise<ManagedToolsRuntime | undefined>;
