// Destination for signed-in users leaving the login page: only allowlisted local setup paths are accepted; anything else goes to the home page.
export function authenticatedLoginDestination(
  searchParams: URLSearchParams,
): string {
  return safeAuthenticationReturnTo(searchParams.get("return_to")) ?? "/";
}

export function safeAuthenticationReturnTo(
  value: string | null,
): string | null {
  if (!value || value.length > 2_048) return null;
  let target: URL;
  try {
    target = new URL(value, "http://localhost");
  } catch {
    return null;
  }
  if (target.origin !== "http://localhost" || target.hash !== "") return null;
  const computerSetup =
    target.pathname === "/connect-computer" && target.search.length > 1;
  return computerSetup ? `${target.pathname}${target.search}` : null;
}
