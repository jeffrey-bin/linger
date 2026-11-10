/** Route known embedding restrictions before cancelling a real link click.
 * Cross-origin reachability/CSP cannot be inferred from iframe load events.
 */
export function shouldOpenUrlExternally(
  target: URL,
  page = new URL(window.location.href),
): boolean {
  if (target.origin === page.origin) return true;
  if (page.protocol === "https:" && target.protocol === "http:") return true;
  const host = target.hostname.replace(/\.$/, "");
  if (host.startsWith("[")) {
    const address = host.slice(1, -1);
    // URL canonicalizes IPv4-mapped IPv6 into two hexadecimal words.
    const mapped = /^::ffff:([\da-f]+):[\da-f]+$/.exec(address);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16);
      return isLocalIpv4([high >> 8, high & 255]);
    }
    return (
      address === "::" ||
      address === "::1" ||
      /^(?:f[cd]|fe[89ab])/.test(address)
    );
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return isLocalIpv4(host.split(".").map(Number));
  }
  return (
    !host.includes(".") ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  );
}

function isLocalIpv4([a, b = 0]: number[]) {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
