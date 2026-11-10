import { TeamHubError } from "@/features/teamhub/teamhub-error";
import type { TeamHubBrowserConnectionStatus } from "@/features/teamhub/teamhub-types";

export const PLAYWRIGHT_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm";

type BrowserConnectionTone = "success" | "warning" | "neutral";

export function browserConnectionStateCopy(
  state: TeamHubBrowserConnectionStatus["state"],
): { label: string; short: string; tone: BrowserConnectionTone } {
  switch (state) {
    case "connected":
      return {
        short: "Connected",
        label: "Connected. Browser tasks use your Chrome and its sign-ins.",
        tone: "success",
      };
    case "token_invalid":
      return {
        short: "Token expired",
        label:
          "Token expired. Copy a new token from the extension, then reconnect.",
        tone: "warning",
      };
    case "browser_unavailable":
      return {
        short: "Chrome unavailable",
        label:
          "Can't reach your Chrome. Make sure Chrome is open on this Computer, then reconnect.",
        tone: "warning",
      };
    case "extension_unavailable":
      return {
        short: "Extension unavailable",
        label:
          "Playwright Extension not found. Install and enable it in Chrome, then reconnect.",
        tone: "warning",
      };
    case "not_connected":
      return {
        short: "Not connected",
        label:
          "Not connected. Agent browser tasks wait until you connect your everyday Chrome.",
        tone: "warning",
      };
    case "isolated":
      return {
        short: "Not connected",
        label:
          "Not connected. Agents use a separate browser without your sign-ins.",
        tone: "neutral",
      };
    case "unsupported":
      return {
        short: "Not supported",
        label:
          "This Computer can't use your browser. Agents use a separate browser without your sign-ins.",
        tone: "neutral",
      };
    default:
      // A newer Computer may report a state this Web build does not know.
      return {
        short: "Browser status",
        label: "Browser status unknown",
        tone: "neutral",
      };
  }
}

export function browserConnectionErrorMessage(error: unknown): string {
  const code = error instanceof TeamHubError ? error.code : undefined;
  switch (code) {
    case "INVALID_BROWSER_TOKEN":
      return "Can't read this token. Copy the full line that starts with PLAYWRIGHT_MCP_EXTENSION_TOKEN=, or only the token after the equals sign.";
    case "LOCAL_COMPUTER_OFFLINE":
      return "This Computer is offline. Make sure it's on and running Linger Computer.";
    case "LOCAL_COMPUTER_NOT_FOUND":
      return "Can't find this Computer. It may have been removed.";
    case "BROWSER_CONNECTION_UNSUPPORTED":
      return "Linger Computer on this Computer is out of date. Update it, then connect your browser.";
    case "BROWSER_CONNECTION_TIMEOUT":
      return "Connection timed out. Make sure Chrome is open and the extension is enabled, then try again.";
    case "BROWSER_TOKEN_REJECTED":
      return "The extension didn't accept this token. Copy the current token from the extension, then reconnect.";
    case "BROWSER_EXTENSION_UNAVAILABLE":
      return "Playwright Extension not found. Install and enable it in Chrome, then reconnect.";
    case "BROWSER_UNAVAILABLE":
      return "Google Chrome isn't installed on this Computer. Install Chrome first.";
    case "BROWSER_BUSY":
      return "An Agent task is using this Chrome. Connect after it finishes.";
    case "BROWSER_CONNECTION_INVALID":
      return "The saved browser connection on this Computer is damaged. Paste a token to reconnect.";
    case "BROWSER_CONNECTION_FAILED":
      return "This Computer couldn't connect to your browser. Try again later.";
    default:
      return "Can't connect to the browser right now. Try again later.";
  }
}
