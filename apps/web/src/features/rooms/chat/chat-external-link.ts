import { shouldOpenUrlExternally } from "../url-preview-policy";

export function followChatExternalLink(
  event: {
    altKey: boolean;
    button: number;
    ctrlKey: boolean;
    metaKey: boolean;
    preventDefault: () => void;
    shiftKey: boolean;
  },
  href: string,
  onOpenUrl?: (url: string) => void,
) {
  if (
    !onOpenUrl ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  ) {
    return;
  }
  let target: URL;
  try {
    target = new URL(href, window.location.origin);
  } catch {
    return;
  }
  if (!["http:", "https:"].includes(target.protocol)) return;
  if (shouldOpenUrlExternally(target)) return;
  event.preventDefault();
  onOpenUrl(target.href);
}
