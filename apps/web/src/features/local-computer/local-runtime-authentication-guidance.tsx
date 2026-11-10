import type { TeamHubLocalRuntimeType } from "@/features/teamhub/teamhub-types";

import { appNames } from "./computer-readiness";
import { loginCommands } from "./local-runtime-commands";

export function LocalRuntimeAuthenticationGuidance({
  runtimeType,
  computerName,
}: {
  runtimeType: TeamHubLocalRuntimeType;
  computerName: string;
}) {
  const name = appNames[runtimeType];
  const command = loginCommands[runtimeType];
  return (
    <>
      <p className="font-medium">{name} sign-in required</p>
      <p className="mt-1 text-muted-foreground">
        Run <code className="font-mono">{command}</code> or update the
        configured {name} credentials on {computerName}, using the same OS user
        that runs Local Computer.
      </p>
      {runtimeType === "pi" && (
        <p className="mt-1 text-muted-foreground">
          In Pi, enter /login to sign in, or configure an API key in Pi
          auth.json.
        </p>
      )}
    </>
  );
}
