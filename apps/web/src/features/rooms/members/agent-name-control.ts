export function agentNameControlSize(name: string) {
  let columns = 0;
  for (const char of name) {
    columns += (char.codePointAt(0) ?? 0) > 0x7f ? 2 : 1;
  }
  return Math.max(11, Math.min(32, columns + 2));
}
