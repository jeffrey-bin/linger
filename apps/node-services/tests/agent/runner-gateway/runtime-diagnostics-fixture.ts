import type { RuntimeDiagnostic } from "@linger/wire-contracts/runner-gateway/types";

const checkedAt = "2026-07-29T00:00:00.000Z";

export const runtimeDiagnostics = (options?: {
  readonly authenticationRequired?: readonly RuntimeDiagnostic["type"][];
  readonly ready?: readonly RuntimeDiagnostic["type"][];
  /** How every model is reached; subscription runs several units at once. */
  readonly link?: "api" | "subscription";
}): [RuntimeDiagnostic, RuntimeDiagnostic, RuntimeDiagnostic] => {
  const ready = new Set(options?.ready ?? ["codex"]);
  const authenticationRequired = new Set(options?.authenticationRequired ?? []);
  return (["codex", "claude", "pi"] as const).map((type) => {
    const protocol =
      type === "codex"
        ? ("app-server" as const)
        : type === "claude"
          ? ("stream-json" as const)
          : ("rpc" as const);
    // A current Computer reports each ready Runtime's model catalog.
    const models: NonNullable<RuntimeDiagnostic["models"]> = [
      {
        id: `${type}-default`,
        label: `${type[0]!.toUpperCase()}${type.slice(1)} default`,
        allowed_reasoning_effort: [],
        link: options?.link ?? "subscription",
      },
    ];
    if (ready.has(type)) {
      return {
        type,
        status: "ready" as const,
        protocol,
        checked_at: checkedAt,
        models,
      };
    }
    if (authenticationRequired.has(type)) {
      return {
        type,
        status: "authentication_required" as const,
        protocol,
        checked_at: checkedAt,
        models,
        error: {
          code: "RUNTIME_AUTHENTICATION_REQUIRED" as const,
          message: `${type} authentication is required`,
        },
      };
    }
    return {
      type,
      status: "not_installed" as const,
      protocol,
      checked_at: checkedAt,
      models: [],
      error: {
        code: "RUNTIME_NOT_INSTALLED" as const,
        message: `${type} is not installed`,
      },
    };
  }) as [RuntimeDiagnostic, RuntimeDiagnostic, RuntimeDiagnostic];
};
