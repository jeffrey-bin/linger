import { expect, it } from "vitest";
import { safeAuthenticationReturnTo } from "./authentication-return-to";

const setup = "/connect-computer?code_challenge=challenge&state=state";
it("preserves a same-origin Local Computer setup path after authentication", () => {
  expect(safeAuthenticationReturnTo(setup)).toBe(setup);
});
it.each([
  `https://evil.example${setup}`,
  `//evil.example${setup}`,
  `${setup}#token`,
  "/connect-computer",
  "/rooms/room_private",
])("rejects unsafe or unsupported return paths: %s", (value) => {
  expect(safeAuthenticationReturnTo(value)).toBeNull();
});
