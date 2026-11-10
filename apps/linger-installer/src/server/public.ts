import type { components } from "@linger/wire-contracts/linger-installer/types";
type Computer = components["schemas"]["ComputerStatus"];
export function publicComputer(value: {
  state: Computer["state"];
  detail: string;
  runtimes: unknown[];
  connected?: boolean;
}): Computer {
  return {
    state: value.state,
    ...(value.connected !== undefined ? { connected: value.connected } : {}),
    detail: value.detail,
    runtimes: value.runtimes.flatMap((runtime) => {
      if (!runtime || typeof runtime !== "object") return [];
      const item = runtime as Record<string, unknown>;
      if (typeof item.type !== "string" || typeof item.status !== "string")
        return [];
      return [
        { type: item.type.slice(0, 120), status: item.status.slice(0, 120) },
      ];
    }),
  };
}
