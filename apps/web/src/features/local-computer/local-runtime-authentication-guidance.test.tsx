import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LocalRuntimeAuthenticationGuidance } from "./local-runtime-authentication-guidance";

afterEach(cleanup);

it.each([
  ["codex", "Codex", "codex login"],
  ["claude", "Claude Code", "claude auth login"],
  ["pi", "Pi", "pi"],
] as const)(
  "shows %s authentication instructions without claiming expiry",
  (runtimeType, name, command) => {
    render(
      <LocalRuntimeAuthenticationGuidance
        runtimeType={runtimeType}
        computerName="example-computer / acceptance-user"
      />,
    );
    expect(screen.getByText(`${name} sign-in required`)).toBeVisible();
    expect(screen.getByText(command)).toBeVisible();
    expect(screen.getByText(/same OS user/)).toHaveTextContent(
      "example-computer / acceptance-user",
    );
    expect(
      screen.queryByText(/expired|recover automatically/),
    ).not.toBeInTheDocument();
    if (runtimeType === "pi")
      expect(screen.getByText(/In Pi, enter \/login/)).toBeVisible();
    if (runtimeType !== "claude")
      expect(screen.queryByText("claude auth login")).not.toBeInTheDocument();
  },
);
