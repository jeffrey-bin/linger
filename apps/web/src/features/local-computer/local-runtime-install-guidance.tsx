import type { TeamHubLocalRuntimeType } from "@/features/teamhub/teamhub-types";

import type { ComputerPlatform } from "./computer-platform";
import { appNames } from "./computer-readiness";
import { installCommand } from "./local-runtime-commands";

export function LocalRuntimeInstallGuidance({
  runtimeTypes,
  platform,
  computerName,
}: {
  runtimeTypes: readonly TeamHubLocalRuntimeType[];
  platform?: ComputerPlatform;
  computerName: string;
}) {
  if (runtimeTypes.length === 0) return null;
  return (
    <div className="text-xs text-muted-foreground">
      <p>
        Install a Runtime on {computerName} as the OS user that runs Local
        Computer{platform === "win32" ? ", in PowerShell" : ""}. It appears here
        within a minute.
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {runtimeTypes.map((runtimeType) => (
          <li key={runtimeType}>
            {appNames[runtimeType]}:{" "}
            <code className="select-all font-mono text-foreground">
              {installCommand(runtimeType, platform)}
            </code>
          </li>
        ))}
      </ul>
      {runtimeTypes.some((runtimeType) => runtimeType !== "claude") ? (
        <p className="mt-2">The npm commands need Node.js.</p>
      ) : null}
    </div>
  );
}
