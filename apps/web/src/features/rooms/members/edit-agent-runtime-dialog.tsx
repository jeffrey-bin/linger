import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useId } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Select, SelectItem } from "@/components/ui/select";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubAgentReasoningEffort,
  TeamHubLocalRuntimeType,
  TeamHubTenantAgent,
  TeamHubTenantAgentUpdateInput,
} from "@/features/teamhub/teamhub-types";

import {
  agentRuntimeUpdate,
  describeMissingDefault,
  type LocalComputer,
  OFFLINE_COMPUTER_HINT,
  runtimeLabels,
} from "./agent-move-target";
import { useAgentMoveTarget } from "./use-agent-move-target";
import { reasoningEffortLabel } from "./use-agent-model-selection";

type Runtime = NonNullable<TeamHubTenantAgentUpdateInput["runtime"]>;

/** The row that opened the dialog. Opened from Computer or Runtime, every
 * field is editable; opened from Model or Reasoning, the placement stays
 * locked, and Reasoning also locks the model. */
export type AgentRuntimeField = "computer" | "runtime" | "model" | "reasoning";

export interface AgentRuntimeUpdateInput {
  runtime: Runtime;
}

export const agentMoveHint =
  "Moving starts a new native Runtime session on the new computer. Local files stay on the old computer.";

export function EditAgentRuntimeDialog({
  busy = false,
  field = "runtime",
  client,
  error,
  isPending,
  onClose,
  onSave,
  registration,
  tenantId,
}: {
  busy?: boolean;
  client: Pick<TeamHubClient, "listTenantLocalComputers">;
  field?: AgentRuntimeField;
  error?: string;
  isPending: boolean;
  onClose: () => void;
  onSave: (input: AgentRuntimeUpdateInput) => void;
  registration: TeamHubTenantAgent;
  tenantId: string;
}) {
  const formId = useId();
  const computers = useQuery({
    queryFn: () => client.listTenantLocalComputers(tenantId),
    queryKey: ["teamhub", "local-computers", tenantId],
    retry: false,
    refetchInterval: 5_000,
  });
  const selection = useAgentMoveTarget(registration, computers.data?.items);
  const { computer, grant, localReady, model, moving, runtime, target } =
    selection;
  const modelIsAvailable = Boolean(selection.selectedModel);
  const loading = computers.isPending;
  const placementLocked = field === "model" || field === "reasoning";
  const noWritableGrant = moving && Boolean(computer) && !grant;
  const unavailable =
    computers.isError || (!loading && (!computer || (!moving && !grant)));
  const canSave = Boolean(modelIsAvailable && localReady && target);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave || !target || isPending || busy) return;
    onSave({ runtime: agentRuntimeUpdate(target) });
  }

  return (
    <ModalDialog
      onClose={onClose}
      size="md"
      title="Runtime settings"
      footer={
        <>
          <Button onClick={onClose} type="button">
            Cancel
          </Button>
          <Button
            disabled={busy || isPending || loading || unavailable || !canSave}
            form={formId}
            loading={isPending}
            tone="primary"
            type="submit"
          >
            {moving ? "Move Agent" : "Save Runtime"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <fieldset
          className="space-y-4 px-5 py-4"
          disabled={isPending || loading}
        >
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Computer</span>
            <Select
              aria-label="Agent computer"
              className="ui-field-control w-full"
              disabled={placementLocked}
              onValueChange={selection.selectComputer}
              placeholder="Choose a computer"
              value={selection.computerId}
            >
              {(computers.data?.items ?? []).map((item) => (
                <SelectItem
                  disabled={item.upgrade_required}
                  key={item.computer_id}
                  value={item.computer_id}
                >
                  {computerOptionLabel(item)}
                </SelectItem>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Runtime</span>
            <Select
              aria-label="Agent runtime"
              className="ui-field-control w-full"
              disabled={placementLocked}
              onValueChange={(value) =>
                selection.selectRuntime(value as TeamHubLocalRuntimeType)
              }
              placeholder="Choose a runtime"
              value={selection.runtimeType}
            >
              {(computer?.runtimes ?? []).map((item) => (
                <SelectItem key={item.type} value={item.type}>
                  {runtimeLabels[item.type]}
                  {item.status === "ready" ? "" : " · Unavailable"}
                </SelectItem>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Model</span>
            <Select
              aria-label="Agent model"
              className="ui-field-control w-full"
              disabled={field === "reasoning"}
              onValueChange={selection.selectModel}
              value={model}
            >
              {model && !modelIsAvailable ? (
                <SelectItem value={model} disabled>
                  {model} · Unavailable
                </SelectItem>
              ) : null}
              {selection.modelOptions.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </Select>
          </label>
          <ReasoningField
            allowed={selection.selectedModel?.allowed_reasoning_effort}
            onChange={selection.selectReasoningEffort}
            savedUnavailableEffort={selection.savedUnavailableEffort}
            value={selection.reasoningEffort}
          />
          {busy ? (
            <p className="text-sm text-app-subtle" role="status">
              Wait for this Agent to finish before saving changes.
            </p>
          ) : null}
          {moving && computer ? (
            <p className="text-sm text-app-subtle" role="status">
              {agentMoveHint}
            </p>
          ) : null}
          {computer?.status === "offline" && !computer.upgrade_required ? (
            <p className="text-sm text-app-subtle" role="status">
              {OFFLINE_COMPUTER_HINT}
            </p>
          ) : null}
          {moving && computer && !selection.runtimeType ? (
            <p className="text-sm text-app-danger" role="alert">
              {describeMissingDefault(registration, [computer])}
            </p>
          ) : null}
          {noWritableGrant ? (
            <p className="text-sm text-app-danger" role="alert">
              This computer has no writable workspace. Choose another computer.
            </p>
          ) : null}
          {!loading &&
          !unavailable &&
          !modelIsAvailable &&
          runtime?.status === "ready" ? (
            <p className="text-sm text-app-danger" role="alert">
              {selection.modelOptions.length
                ? "The current model is unavailable. Choose another model."
                : "No models are available for this runtime."}
            </p>
          ) : null}
          {!localReady && !loading && !unavailable && selection.runtimeType ? (
            <p className="text-sm text-app-danger" role="alert">
              {runtime?.message ??
                "Install and sign in to this runtime on the computer, then wait for it to become ready."}
            </p>
          ) : null}
          {unavailable ? (
            <p className="text-sm text-app-danger" role="alert">
              Runtime options are unavailable.
              <button
                className="ml-2 underline"
                type="button"
                onClick={() => void computers.refetch()}
              >
                Retry
              </button>
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-app-danger" role="alert">
              {error}
            </p>
          ) : null}
        </fieldset>
      </form>
    </ModalDialog>
  );
}

function computerOptionLabel(computer: LocalComputer) {
  return `${computer.display_name} · ${
    computer.status === "online" ? "Online" : "Offline"
  }${computer.upgrade_required ? " · Upgrade required" : ""}`;
}

/* Model and Reasoning are separate choices. While the model's options can't
   be read, its saved Reasoning still shows, marked unavailable like the
   model. */
function ReasoningField({
  allowed,
  onChange,
  savedUnavailableEffort,
  value,
}: {
  allowed?: readonly TeamHubAgentReasoningEffort[];
  onChange: (value: TeamHubAgentReasoningEffort) => void;
  savedUnavailableEffort?: TeamHubAgentReasoningEffort;
  value?: TeamHubAgentReasoningEffort;
}) {
  if (!allowed?.length) {
    if (!savedUnavailableEffort) return null;
    return (
      <div>
        <span className="mb-1.5 block text-sm font-medium">Reasoning</span>
        <Select
          aria-label="Agent reasoning effort"
          className="ui-field-control w-full"
          disabled
          onValueChange={() => {}}
          value={savedUnavailableEffort}
        >
          <SelectItem value={savedUnavailableEffort} disabled>
            {reasoningEffortLabel(savedUnavailableEffort)} · Unavailable
          </SelectItem>
        </Select>
      </div>
    );
  }
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">Reasoning</span>
      <Select
        aria-label="Agent reasoning effort"
        className="ui-field-control w-full"
        onValueChange={(next) => onChange(next as TeamHubAgentReasoningEffort)}
        value={value ?? ""}
      >
        {allowed.map((effort) => (
          <SelectItem key={effort} value={effort}>
            {reasoningEffortLabel(effort)}
          </SelectItem>
        ))}
      </Select>
    </label>
  );
}
