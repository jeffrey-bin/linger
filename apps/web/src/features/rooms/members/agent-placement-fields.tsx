import { RefreshIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { ComputerSetupInstructions } from "@/features/local-computer/computer-setup-instructions";
import { LocalRuntimeAuthenticationGuidance } from "@/features/local-computer/local-runtime-authentication-guidance";

import type { useLocalRuntimeSelection } from "./use-local-runtime-selection";

export function AgentPlacementFields({
  disabled = false,
  invalid = false,
  onSelectionChange,
  selection,
}: {
  disabled?: boolean;
  invalid?: boolean;
  onSelectionChange: () => void;
  selection: ReturnType<typeof useLocalRuntimeSelection>;
}) {
  return (
    // eslint-disable-next-line jsx-a11y/role-supports-aria-props -- aria-description / aria-disabled / aria-invalid are valid ARIA 1.3 global or form-group attributes missing from the rule data
    <div
      aria-invalid={invalid || undefined}
      aria-label="Agent runtime placement"
      className={`space-y-4 rounded-lg transition-shadow ${invalid ? "ring-1 ring-inset ring-app-danger" : ""}`}
      role="group"
      tabIndex={invalid ? -1 : undefined}
    >
      <LocalRuntimeFields
        disabled={disabled}
        onSelectionChange={onSelectionChange}
        selection={selection}
      />
    </div>
  );
}

export function LocalRuntimeFields({
  disabled,
  onSelectionChange,
  selection,
}: {
  disabled: boolean;
  onSelectionChange: () => void;
  selection: ReturnType<typeof useLocalRuntimeSelection>;
}) {
  if (selection.isPending) {
    return (
      <LocalRuntimeStatus>Looking for Local Computers...</LocalRuntimeStatus>
    );
  }
  if (selection.error) {
    return (
      <LocalComputerSetupPrompt
        connected={false}
        disabled={disabled}
        onRetry={() => void selection.refetch()}
        title="Local Computers are unavailable."
        titleTone="danger"
      />
    );
  }
  if (!selection.computer) {
    return (
      <LocalComputerSetupPrompt
        connected={false}
        disabled={disabled}
        onRetry={() => void selection.refetch()}
        title="No Local Computer online"
      />
    );
  }

  return (
    <div className="grid gap-3 rounded-lg bg-app-sidebar p-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Computer</span>
        <Select
          aria-label="Local Computer"
          className="ui-field-control w-full"
          disabled={disabled}
          onValueChange={(value) => {
            onSelectionChange();
            selection.selectComputer(value);
          }}
          value={selection.computer.computer_id}
        >
          {selection.computers.map((computer) => (
            <SelectItem key={computer.computer_id} value={computer.computer_id}>
              {computer.display_name}
            </SelectItem>
          ))}
        </Select>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Runtime</span>
        <Select
          aria-label="Local Runtime"
          className="ui-field-control w-full capitalize"
          disabled={disabled}
          onValueChange={(value) => {
            onSelectionChange();
            selection.selectRuntime(value);
          }}
          value={selection.runtime}
        >
          {selection.computer.runtimes.map((runtime) => (
            <SelectItem
              disabled={
                runtime.status !== "ready" &&
                runtime.status !== "authentication_required"
              }
              key={runtime.type}
              value={runtime.type}
            >
              {runtimeLabel(runtime.type, runtime.status)}
            </SelectItem>
          ))}
        </Select>
      </label>
      {selection.runtimeDiagnostic?.status === "authentication_required" ? (
        <div
          className="rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] p-3 text-sm text-app-body"
          role="status"
        >
          <LocalRuntimeAuthenticationGuidance
            runtimeType={selection.runtimeDiagnostic.type}
            computerName={selection.computer.display_name}
          />
        </div>
      ) : null}
      <p className="text-xs leading-4 text-app-muted">
        Apps and Skills stay on this machine.
      </p>
    </div>
  );
}

function runtimeLabel(
  type: string,
  status:
    | "not_installed"
    | "authentication_required"
    | "ready"
    | "incompatible"
    | "error"
    | "unknown",
) {
  const detail = {
    authentication_required: "Sign in required",
    error: "Detection failed",
    unknown: "Status unavailable",
    incompatible: "Upgrade required",
    not_installed: "Not installed",
    ready: "Ready",
  }[status];
  return `${type} - ${detail}`;
}

function LocalComputerSetupPrompt({
  connected,
  disabled,
  onRetry,
  title,
  titleTone,
}: {
  connected: boolean;
  disabled: boolean;
  onRetry: () => void;
  title: string;
  titleTone?: "danger";
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p
          className={`text-sm font-medium ${titleTone === "danger" ? "text-app-danger" : "text-app-body"}`}
        >
          {title}
        </p>
        <Button
          aria-label="Retry Local Computers"
          disabled={disabled}
          onClick={onRetry}
          size="compact"
          type="button"
        >
          <Icon icon={RefreshIcon} size={14} />
          Retry
        </Button>
      </div>
      <ComputerSetupInstructions connected={connected} />
    </div>
  );
}

function LocalRuntimeStatus({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-app-muted">
      {children}
    </p>
  );
}
