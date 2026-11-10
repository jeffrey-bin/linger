const cjk = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

/**
 * What goes between two spoken fragments of one passage: CJK text runs on
 * directly, while Latin words keep a single space between them.
 */
export function spokenSeparator(before: string, after: string) {
  const last = before.at(-1);
  const first = after[0];
  if (!last || !first || /\s/u.test(last)) return "";
  return cjk.test(last) || cjk.test(first) ? "" : " ";
}
