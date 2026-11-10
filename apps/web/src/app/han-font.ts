// Language tags whose readers expect Simplified Chinese glyph forms. Traditional
// Chinese (zh-TW, zh-HK, zh-Hant) and Japanese keep the OS fallback, which picks
// the glyph forms those readers expect.
const simplifiedChineseTag = /^zh(?:-(?:cn|sg|hans)(?:-|$)|$)/u;

export function prefersSimplifiedChinese(
  languages: readonly string[],
): boolean {
  return languages.some((tag) => simplifiedChineseTag.test(tag.toLowerCase()));
}

/**
 * Loads Noto Sans SC only for Simplified Chinese readers, so other users skip
 * its stylesheet and get their OS font for any script. The root attribute
 * switches the font stack in globals.css; voice-pip copies it to its window.
 */
export function loadHanFont(languages: readonly string[]) {
  if (!prefersSimplifiedChinese(languages)) return;
  document.documentElement.dataset.hanFont = "sc";
  // A missing font only falls back to OS fonts, so a failed load is ignored.
  import("@fontsource-variable/noto-sans-sc").catch(() => {});
}
