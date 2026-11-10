const roomMessagePath = /^\/t\/[^/?#]+\/rooms\/[^/?#]+\/chat\?message=[^&#]+$/u;

/** Whether a link opens a Room message inside the app. */
export function isWikiCitationHref(reference: string): boolean {
  return roomMessagePath.test(reference.trim());
}
