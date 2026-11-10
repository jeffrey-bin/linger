/** Paths sharing a secondary navigation keep their layout mounted. */
export function routeLayoutKey(pathname: string): string {
  // An opened Document sits inside the Workspace layout beside Library pages.
  const workspace = pathname.match(
    /^(\/t\/[^/]+)\/(?:library|documents)(?=\/|$)/,
  );
  if (workspace) return `${workspace[1]}/library`;
  return (
    pathname.match(/^\/t\/[^/]+\/settings(?=\/|$)/)?.[0] ??
    pathname.match(/^\/t\/[^/]+\/rooms\/[^/]+(?=\/|$)/)?.[0] ??
    pathname
  );
}
