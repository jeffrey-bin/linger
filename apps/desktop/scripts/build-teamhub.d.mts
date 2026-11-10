export interface TeamhubManifest {
  target: string;
  sourceCommit: string;
  sourceArchiveSha256: string;
  goVersion: string;
  binaries: Record<string, { file: string; sha256: string; bytes: number }>;
}
export const TEAMHUB_TARGETS: string[];
export function teamhubDirectory(target: string): string;
export function sourceCommit(archive: string): Promise<string>;
export function verifyTeamhub(
  directory: string,
  target: string,
  sourceArchiveSha256: string,
): Promise<TeamhubManifest>;
export function buildTeamhub(
  target: string,
  archive: string,
  output?: string,
): Promise<TeamhubManifest>;
