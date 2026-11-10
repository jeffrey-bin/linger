import { Add01Icon, ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Select, SelectItem } from "@/components/ui/select";
import { ComputerSetupInstructions } from "@/features/local-computer/computer-setup-instructions";
import { useDesktopComputer } from "@/features/local-computer/desktop-computer";
import { DesktopComputerSetup } from "@/features/local-computer/desktop-computer-setup";
import { subscribeLocalComputerEnrollment } from "@/features/local-computer/local-computer-enrollment-events";
import { localComputersQueryKey } from "@/features/local-computer/local-computer-queries";
import { LocalRuntimeAuthenticationGuidance } from "@/features/local-computer/local-runtime-authentication-guidance";
import { LocalRuntimeInstallGuidance } from "@/features/local-computer/local-runtime-install-guidance";
import { ServerConnection } from "@/features/local-computer/server-connection";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubAgentReasoningEffort,
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
} from "@/features/teamhub/teamhub-types";

import {
  QuickCreateGeneralAgent,
  type LocalAgentTarget,
} from "./quick-create-general-agent-page";
import { AgentCreationProgress } from "./agent-creation-progress";
import { OFFLINE_COMPUTER_HINT } from "./members/agent-move-target";

const localRuntimeLabels: Record<TeamHubLocalRuntimeType, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

const effortLabels: Record<TeamHubAgentReasoningEffort, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
  ultra: "Ultra",
};

export function QuickCreateLocalAgentDialog({
  tenantId,
  onClose,
}: {
  tenantId: string;
  onClose: () => void;
}) {
  const { client } = useTeamHubRuntime();
  const [computerId, setComputerId] = useState("");
  const [runtimeType, setRuntimeType] = useState<TeamHubLocalRuntimeType>();
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState<TeamHubAgentReasoningEffort>();
  const [target, setTarget] = useState<LocalAgentTarget>();
  const desktop = useDesktopComputer();
  const desktopComputerId = desktop?.status?.computerId;
  const [connection, setConnection] = useState<{
    knownIds: ReadonlySet<string>;
    expectedId?: string;
  }>();
  useEffect(
    () =>
      subscribeLocalComputerEnrollment((event) => {
        if (event.tenantId === tenantId)
          setConnection((current) =>
            current ? { ...current, expectedId: event.computerId } : current,
          );
      }),
    [tenantId],
  );
  const computers = useQuery({
    queryKey: localComputersQueryKey(tenantId),
    queryFn: () => client.listTenantLocalComputers(tenantId),
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: (query) =>
      query.state.error ||
      target ||
      (!connection &&
        hasReadyLocalModel(
          query.state.data,
          computerId || desktopComputerId || "",
          runtimeType,
        ))
        ? false
        : 2_000,
  });
  // An offline Computer can take a new Agent; it runs once it connects.
  const selectableComputers =
    computers.isFetchedAfterMount && !computers.error
      ? (computers.data?.items.filter(
          (computer) => !computer.upgrade_required,
        ) ?? [])
      : [];
  const desktopComputer = selectableComputers.find(
    (computer) => computer.computer_id === desktopComputerId,
  );
  // In the desktop app the computer it runs on is chosen by default.
  const selectedComputerId = computerId || desktopComputer?.computer_id || "";
  const selectedComputer = selectableComputers.find(
    (computer) => computer.computer_id === selectedComputerId,
  );
  const selectedRuntime =
    selectedComputer?.runtimes.find(
      (runtime) => runtime.type === runtimeType,
    ) ??
    selectedComputer?.runtimes.find(
      (runtime) => runtime.status === "ready" && runtime.models.length > 0,
    ) ??
    selectedComputer?.runtimes[0];
  const modelOptions =
    selectedComputer?.workspace_grants.length &&
    selectedRuntime?.status === "ready"
      ? selectedRuntime.models
      : [];
  const selectedModel =
    modelOptions.find((model) => model.id === modelId) ?? modelOptions[0];
  const allowedEfforts = selectedModel?.allowed_reasoning_effort ?? [];
  const selectedEffort =
    effort && allowedEfforts.includes(effort)
      ? effort
      : selectedModel?.default_reasoning_effort &&
          allowedEfforts.includes(selectedModel.default_reasoning_effort)
        ? selectedModel.default_reasoning_effort
        : allowedEfforts[0];
  const pending =
    computers.isPending ||
    (!computers.isFetchedAfterMount && computers.isFetching);
  // The desktop app connects its own computer, so it never shows the CLI
  // setup until the user asks to connect another one.
  const desktopSetupOpen =
    !computers.error && !connection && Boolean(desktop) && !desktopComputer;
  const setupOpen =
    !computers.error &&
    (Boolean(connection) || desktopSetupOpen || !selectableComputers.length);
  const connectedComputer = connection
    ? selectableComputers.find(
        (computer) =>
          computer.status === "online" &&
          (connection.expectedId
            ? computer.computer_id === connection.expectedId
            : !connection.knownIds.has(computer.computer_id)),
      )
    : undefined;
  const connectedReady = connectedComputer
    ? hasReadyLocalModel(
        { items: [connectedComputer] },
        connectedComputer.computer_id,
      )
    : false;
  const loginComputer = setupOpen ? connectedComputer : selectedComputer;
  const loginRuntime = setupOpen
    ? loginComputer?.runtimes.find(
        (runtime) => runtime.status === "authentication_required",
      )
    : selectedRuntime?.status === "authentication_required"
      ? selectedRuntime
      : undefined;

  function selectComputer(value: string) {
    setComputerId(value);
    setRuntimeType(undefined);
    setModelId("");
    setEffort(undefined);
  }

  if (target)
    return (
      <ModalDialog onClose={onClose} size="md" title="Create local agent">
        <div className="px-5 py-4">
          <QuickCreateGeneralAgent
            tenantId={tenantId}
            localTarget={target}
            onCreated={onClose}
          />
        </div>
      </ModalDialog>
    );

  return (
    <ModalDialog
      onClose={onClose}
      size="md"
      title="Create local agent"
      description={
        setupOpen
          ? "Connect a computer, then choose your runtime and model."
          : "Choose a computer, runtime and model for your Agent."
      }
      footer={
        !pending ? (
          <>
            <Button
              onClick={connection ? () => setConnection(undefined) : onClose}
            >
              {connection ? "Back" : "Cancel"}
            </Button>
            {connection ? (
              <Button
                tone="primary"
                disabled={!connectedReady}
                onClick={() => {
                  if (!connectedComputer) return;
                  selectComputer(connectedComputer.computer_id);
                  setConnection(undefined);
                }}
              >
                Use this computer
              </Button>
            ) : !setupOpen ? (
              <Button
                tone="primary"
                disabled={
                  !selectedComputer || !selectedRuntime || !selectedModel
                }
                onClick={() => {
                  if (!selectedComputer || !selectedRuntime || !selectedModel)
                    return;
                  setTarget({
                    computerId: selectedComputer.computer_id,
                    workspaceGrantId:
                      selectedComputer.workspace_grants[0]!.grant_id,
                    runtimeType: selectedRuntime.type,
                    model: selectedModel.id,
                    reasoningEffort: selectedEffort,
                  });
                }}
              >
                Create
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <div className="space-y-4 px-5 py-4">
        {pending ? (
          <div className="flex justify-center px-4 py-3">
            <AgentCreationProgress stage="preparing" />
          </div>
        ) : computers.error ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 text-sm text-app-danger"
          >
            Local Computers are unavailable.
            <Button onClick={() => void computers.refetch()} size="compact">
              Retry
            </Button>
          </div>
        ) : desktop && desktopSetupOpen ? (
          <DesktopComputerSetup desktop={desktop} />
        ) : setupOpen ? (
          <>
            {connection && selectableComputers.length > 0 ? (
              <Button
                size="compact"
                tone="ghost"
                onClick={() => setConnection(undefined)}
              >
                <Icon icon={ArrowLeft01Icon} size={14} /> Back to computer
                selection
              </Button>
            ) : null}
            <ComputerSetupInstructions
              connected={Boolean(connectedComputer)}
              waitingForNewComputer={Boolean(connection)}
            />
            {connectedComputer ? (
              <p className="text-sm" role="status">
                Connected: {connectedComputer.display_name}
              </p>
            ) : null}
            {connectedComputer && !connectedComputer.workspace_grants.length ? (
              <p className="text-xs text-app-muted" role="status">
                Authorize workspace access on this computer before continuing.
              </p>
            ) : null}
            <ServerConnection tenantId={tenantId} />
          </>
        ) : (
          <>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label
                  className="text-sm font-medium"
                  htmlFor="local-agent-computer"
                >
                  Local Computer
                </label>
                <Button
                  size="compact"
                  tone="ghost"
                  onClick={() =>
                    setConnection({
                      knownIds: new Set(
                        computers.data?.items.map(
                          (computer) => computer.computer_id,
                        ),
                      ),
                    })
                  }
                >
                  <span className="inline-flex items-center gap-1.5 text-app-info">
                    <Icon icon={Add01Icon} size={14} /> Connect new computer
                  </span>
                </Button>
              </div>
              <Select
                id="local-agent-computer"
                aria-label="Local Computer"
                className="min-w-0 w-full"
                onValueChange={selectComputer}
                placeholder="Select a Local Computer"
                value={selectedComputerId}
              >
                {selectableComputers.map((computer) => (
                  <SelectItem
                    key={computer.computer_id}
                    value={computer.computer_id}
                  >
                    {computer.display_name}
                    {computer.status === "online" ? "" : " · Offline"}
                  </SelectItem>
                ))}
              </Select>
              {selectedComputer?.status === "offline" ? (
                <p className="mt-1.5 text-xs text-app-muted" role="status">
                  {OFFLINE_COMPUTER_HINT}
                </p>
              ) : null}
            </div>
            {selectedComputer ? (
              <>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">
                    Runtime
                  </span>
                  <Select
                    aria-label="Runtime"
                    className="min-w-0 w-full"
                    disabled={!selectedComputer.runtimes.length}
                    placeholder="No runtimes available"
                    value={selectedRuntime?.type ?? ""}
                    onValueChange={(value) => {
                      setRuntimeType(value as TeamHubLocalRuntimeType);
                      setModelId("");
                      setEffort(undefined);
                    }}
                  >
                    {selectedComputer.runtimes.map((runtime) => (
                      <SelectItem key={runtime.type} value={runtime.type}>
                        {localRuntimeLabels[runtime.type]}
                      </SelectItem>
                    ))}
                  </Select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">
                    Model
                  </span>
                  <Select
                    aria-label="Model"
                    className="min-w-0 w-full"
                    disabled={!modelOptions.length}
                    placeholder="No models available"
                    value={selectedModel?.id ?? ""}
                    onValueChange={(value) => {
                      setModelId(value);
                      setEffort(undefined);
                    }}
                  >
                    {modelOptions.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </Select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">
                    Thinking effort
                  </span>
                  <Select
                    aria-label="Thinking effort"
                    className="min-w-0 w-full"
                    disabled={!allowedEfforts.length}
                    placeholder="Not supported"
                    value={selectedEffort ?? ""}
                    onValueChange={(value) =>
                      setEffort(value as TeamHubAgentReasoningEffort)
                    }
                  >
                    {allowedEfforts.map((value) => (
                      <SelectItem key={value} value={value}>
                        {effortLabels[value]}
                      </SelectItem>
                    ))}
                  </Select>
                </label>
                {!selectedModel && !loginRuntime ? (
                  selectedComputer &&
                  selectedRuntime?.status === "not_installed" ? (
                    <div role="status">
                      <LocalRuntimeInstallGuidance
                        computerName={selectedComputer.display_name}
                        platform={selectedComputer.platform}
                        runtimeTypes={[selectedRuntime.type]}
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-app-muted" role="status">
                      No models are available on this Runtime. Check its status
                      and workspace access.
                    </p>
                  )
                ) : null}
              </>
            ) : null}
          </>
        )}
        {loginComputer && loginRuntime ? (
          <div className="text-xs text-app-muted" role="status">
            <LocalRuntimeAuthenticationGuidance
              computerName={loginComputer.display_name}
              runtimeType={loginRuntime.type}
            />
          </div>
        ) : null}
      </div>
    </ModalDialog>
  );
}

function hasReadyLocalModel(
  page: TeamHubLocalComputerPage | undefined,
  computerId: string,
  runtimeType?: TeamHubLocalRuntimeType,
) {
  return (
    page?.items.some(
      (computer) =>
        (!computerId || computer.computer_id === computerId) &&
        computer.status === "online" &&
        computer.workspace_grants.length > 0 &&
        computer.runtimes.some(
          (runtime) =>
            (!runtimeType || runtime.type === runtimeType) &&
            runtime.status === "ready" &&
            runtime.models.length > 0,
        ),
    ) ?? false
  );
}
