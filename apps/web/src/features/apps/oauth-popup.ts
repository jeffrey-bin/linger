const OAUTH_POPUP_NAME = "linger_composio_oauth";
const OAUTH_POPUP_WIDTH = 560;
const OAUTH_POPUP_HEIGHT = 720;

export function openOAuthPopup(connectUrl: string): Window | null {
  const left = Math.max(
    0,
    Math.round(window.screenX + (window.outerWidth - OAUTH_POPUP_WIDTH) / 2),
  );
  const top = Math.max(
    0,
    Math.round(window.screenY + (window.outerHeight - OAUTH_POPUP_HEIGHT) / 2),
  );
  return window.open(
    connectUrl,
    OAUTH_POPUP_NAME,
    [
      "popup=yes",
      `width=${OAUTH_POPUP_WIDTH}`,
      `height=${OAUTH_POPUP_HEIGHT}`,
      `left=${left}`,
      `top=${top}`,
      "resizable=yes",
      "scrollbars=yes",
    ].join(","),
  );
}

export function openOAuthUrl(connectUrl: string): boolean {
  return Boolean(openOAuthPopup(connectUrl));
}
