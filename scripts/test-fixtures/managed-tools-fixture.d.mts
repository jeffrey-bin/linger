export function managedToolsFixture(
  source: string,
  id: string,
  version?: string,
  teamhubVersion?: string,
): Promise<void>;
export function writeManagedToolsReadOnlyGuard(
  filename: string,
  root: string,
): Promise<void>;
