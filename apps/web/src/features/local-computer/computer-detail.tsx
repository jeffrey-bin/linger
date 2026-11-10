import {
  Activity01Icon,
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  Folder01Icon,
  InformationCircleIcon,
  Key01Icon,
  LaptopIcon,
  Link01Icon,
  PlayIcon,
  PowerIcon,
  RefreshIcon,
  Search01Icon,
  StopIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import type {
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";
import { cn } from "@/lib/cn";

import {
  agentStatusSummary,
  type AgentAvailability,
} from "./agent-availability";
import { AgentChips } from "./computer-agent-chips";
import { appIcons } from "./computer-app-icons";
import { AppSetupDialog, CommandLine } from "./computer-app-setup-dialog";
import {
  useComputerConnectionStatus,
  type ComputerDisplayStatus,
} from "./computer-connection-status";
import { Hint, HintCard } from "./computer-hint";
import {
  computerCommand,
  computerInstallCommand,
  ComputerPlatformSelector,
  type ComputerPlatform,
} from "./computer-platform";
import {
  appDescriptions,
  appNames,
  appOrder,
  computerReadiness,
  type ComputerReadiness,
} from "./computer-readiness";
import { relativeTime } from "./computer-relative-time";
import { ComputerRow, ProgressChip, RowMark, StatusDot } from "./computer-row";
import { isUpgradeRecommended } from "./computer-version";

type LocalComputer = TeamHubLocalComputerPage["items"][number];
interface AppSetup {
  app: TeamHubLocalRuntimeType;
  choosable: boolean;
}

export function ComputerDetail({
  agentAvailabilities,
  agents,
  browserConnection,
  computer: latestComputer,
  onConnect,
  onOpenAgent,
  onRemove,
}: {
  agentAvailabilities: ReadonlyMap<string, AgentAvailability>;
  agents: TeamHubTenantAgent[];
  /** The browser status as a progress chip or an Access row; the page owns its TeamHub reads. */
  browserConnection?: (variant: "chip" | "row") => ReactNode;
  computer: LocalComputer;
  onConnect?: () => void;
  onOpenAgent: (actorId: string) => void;
  onRemove?: () => void;
}) {
  const [reportedComputer, setReportedComputer] = useState(latestComputer);
  if (
    reportedComputer.computer_id !== latestComputer.computer_id ||
    (latestComputer.status === "online" && reportedComputer !== latestComputer)
  ) {
    setReportedComputer(latestComputer);
  }
  // An offline Computer keeps showing what it last reported.
  const computer =
    latestComputer.status === "offline" &&
    reportedComputer.computer_id === latestComputer.computer_id
      ? {
          ...latestComputer,
          daemon_version: reportedComputer.daemon_version,
          platform: latestComputer.platform ?? reportedComputer.platform,
          recommended_version:
            latestComputer.recommended_version ??
            reportedComputer.recommended_version,
          runtimes: reportedComputer.runtimes,
        }
      : latestComputer;
  const displayStatus = useComputerConnectionStatus(
    computer.computer_id,
    computer.status,
  );
  const readiness = computerReadiness(computer, displayStatus);
  const [setup, setSetup] = useState<AppSetup | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const online = displayStatus === "online";
  const openSetup = (app: TeamHubLocalRuntimeType, choosable = false) =>
    setSetup({ app, choosable });

  return (
    <div
      aria-label={`${computer.display_name} details`}
      className="w-full"
      role="region"
    >
      <ComputerSummary
        browserChip={browserConnection?.("chip")}
        computer={computer}
        displayStatus={displayStatus}
        onConnect={onConnect}
        onSetUp={openSetup}
        onUpdate={() => setUpdateOpen(true)}
        readiness={readiness}
      />
      <Group
        count={agents.length}
        summary={agentStatusSummary(agentAvailabilities, agents)}
        title="Agents"
      >
        <AgentChips
          agentAvailabilities={agentAvailabilities}
          agents={agents}
          onOpenAgent={onOpenAgent}
        />
      </Group>
      <Group
        hint="Agents use these apps on this computer to do the work. One ready app is enough."
        title="AI apps"
      >
        {appOrder.map((app) => (
          <AppRow
            app={app}
            computer={computer}
            key={app}
            onSetUp={() => openSetup(app)}
            online={online}
          />
        ))}
      </Group>
      {displayStatus === "offline" ? null : (
        <Group defaultOpen={false} title="Access">
          {browserConnection?.("row")}
          <WorkspaceRows computer={computer} />
        </Group>
      )}
      <Group
        defaultOpen={false}
        title="Advanced"
        trailing={
          isUpgradeRecommended(computer) && !computer.upgrade_required ? (
            <span className="rounded-md bg-[var(--app-status-warning-surface)] px-1.5 text-xs text-app-warning">
              Update
            </span>
          ) : null
        }
      >
        <AdvancedRows
          computer={computer}
          onRemove={onRemove}
          onUpdate={() => setUpdateOpen(true)}
        />
      </Group>
      {setup ? (
        <AppSetupDialog
          app={setup.app}
          choosable={setup.choosable}
          computer={computer}
          key={`${setup.app}-${setup.choosable}`}
          onClose={() => setSetup(null)}
        />
      ) : null}
      {updateOpen ? (
        <ModalDialog
          footer={<Button onClick={() => setUpdateOpen(false)}>Close</Button>}
          onClose={() => setUpdateOpen(false)}
          size="md"
          title={
            computer.upgrade_required
              ? "Update required"
              : computer.recommended_version
                ? `Update to ${computer.recommended_version}`
                : "Update Linger Computer"
          }
        >
          <div className="px-5 py-4 text-sm text-muted-foreground">
            <p>
              Wait for running tasks to finish, then run this on{" "}
              {computer.display_name}. Your Agents stay connected.
            </p>
            <UpgradeCommand
              key={computer.computer_id}
              platform={computer.platform}
            />
          </div>
        </ModalDialog>
      ) : null}
    </div>
  );
}

function ComputerSummary({
  browserChip,
  computer,
  displayStatus,
  onConnect,
  onSetUp,
  onUpdate,
  readiness,
}: {
  browserChip?: ReactNode;
  computer: LocalComputer;
  displayStatus: ComputerDisplayStatus;
  onConnect?: () => void;
  onSetUp: (app: TeamHubLocalRuntimeType, choosable?: boolean) => void;
  onUpdate: () => void;
  readiness: ComputerReadiness;
}) {
  const action =
    readiness.kind === "update" ? (
      <Button onClick={onUpdate} tone="primary">
        Update
      </Button>
    ) : readiness.kind === "signIn" ? (
      <Button onClick={() => onSetUp(readiness.app)} tone="primary">
        Sign in to {appNames[readiness.app]}
      </Button>
    ) : readiness.kind === "updateApp" ? (
      <Button onClick={() => onSetUp(readiness.app)} tone="primary">
        Update {appNames[readiness.app]}
      </Button>
    ) : readiness.kind === "check" ? (
      <RuntimeCheckCard align="end" app={readiness.app} computer={computer}>
        <Button tone="primary">Check again</Button>
      </RuntimeCheckCard>
    ) : readiness.kind === "setUp" ? (
      <Button onClick={() => onSetUp(readiness.app, true)} tone="primary">
        Set up {appNames[readiness.app]}
      </Button>
    ) : null;

  return (
    <section className="rounded-xl px-4 py-3.5 shadow-outline">
      <div className="flex items-center gap-3.5">
        <Hint
          focusable
          placement="bottom"
          text={[
            platformLabel(computer.platform),
            computer.daemon_version ? `App ${computer.daemon_version}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <span className="flex size-12 shrink-0 items-center justify-center rounded-[20%] bg-muted text-foreground">
            <Icon icon={LaptopIcon} size={24} />
          </span>
        </Hint>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base">{computer.display_name}</h2>
          <p
            className="flex items-center gap-1.5 text-sm text-muted-foreground"
            role="status"
          >
            <SummaryStatus computer={computer} readiness={readiness} />
          </p>
        </div>
        {action}
      </div>
      {readiness.kind === "offline" ? (
        <OfflineSteps computer={computer} onConnect={onConnect} />
      ) : (
        <div
          className={cn(
            "mt-3.5 ml-[62px] flex flex-wrap items-center gap-y-2",
            displayStatus === "reconnecting" && "opacity-50",
          )}
        >
          {computer.upgrade_required ? (
            <ProgressChip
              hint="This app version is too old to run Agents"
              icon={LaptopIcon}
              attentionIcon={RefreshIcon}
              label="Update"
              onClick={onUpdate}
              state="attention"
            />
          ) : (
            <ProgressChip
              hint="The Linger app is running"
              icon={LaptopIcon}
              label="Connected"
              state="done"
            />
          )}
          <span aria-hidden className="w-6 border-t border-border-hover" />
          {readiness.kind === "ready" ? (
            <ProgressChip
              hint={`Agents use ${appNames[readiness.app]} here`}
              icon={appIcons[readiness.app]}
              label={appNames[readiness.app]}
              state="done"
            />
          ) : readiness.kind === "signIn" ? (
            <ProgressChip
              hint={`${appNames[readiness.app]} is installed but signed out`}
              icon={appIcons[readiness.app]}
              attentionIcon={Key01Icon}
              label="Sign in"
              onClick={() => onSetUp(readiness.app)}
              state="attention"
            />
          ) : readiness.kind === "updateApp" ? (
            <ProgressChip
              attentionIcon={RefreshIcon}
              hint={`${appNames[readiness.app]} is too old to run Agents`}
              icon={appIcons[readiness.app]}
              label="Update"
              onClick={() => onSetUp(readiness.app)}
              state="attention"
            />
          ) : readiness.kind === "check" ? (
            <ProgressChip
              attentionIcon={Search01Icon}
              hint={runtimeMessage(computer, readiness.app)}
              icon={appIcons[readiness.app]}
              label={appNames[readiness.app]}
              state="attention"
            />
          ) : (
            <ProgressChip
              attentionIcon={Add01Icon}
              hint="Agents need Claude Code, Codex or Pi on this computer"
              icon={appIcons.claude}
              label={appNames.claude}
              onClick={() => onSetUp("claude", true)}
              state="attention"
            />
          )}
          <span
            aria-hidden
            className={cn(
              "w-6 border-t border-border-hover",
              readiness.kind !== "ready" && "border-dashed",
            )}
          />
          {browserChip}
        </div>
      )}
    </section>
  );
}

function SummaryStatus({
  computer,
  readiness,
}: {
  computer: LocalComputer;
  readiness: ComputerReadiness;
}) {
  if (readiness.kind === "reconnecting")
    return <span className="town-shimmer-text">Reconnecting…</span>;
  if (readiness.kind === "offline")
    return (
      <>
        <StatusDot tone="neutral" />
        {computer.last_seen_at
          ? `Offline · ${relativeTime(computer.last_seen_at)}`
          : "Offline"}
      </>
    );
  if (readiness.kind === "update")
    return (
      <>
        <StatusDot tone="warning" />
        Update required
      </>
    );
  if (readiness.kind === "check")
    return (
      <>
        <StatusDot tone="warning" />
        Couldn't check {appNames[readiness.app]}
      </>
    );
  if (readiness.kind === "ready")
    return (
      <>
        <StatusDot tone="success" />
        {computer.active_operations
          ? `Ready · ${computer.active_operations} running`
          : "Ready"}
      </>
    );
  return (
    <>
      <StatusDot tone="warning" />
      One step left
    </>
  );
}

function OfflineSteps({
  computer,
  onConnect,
}: {
  computer: LocalComputer;
  onConnect?: () => void;
}) {
  const step =
    "inline-flex h-8 items-center gap-2 rounded-full bg-card pr-3 pl-1.5 text-xs text-secondary-foreground shadow-outline";
  const bubble =
    "flex size-[22px] items-center justify-center rounded-full bg-muted";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2.5 rounded-xl bg-muted px-3.5 py-3">
      <Hint
        focusable
        placement="bottom"
        text="Turn it on and connect to the internet. It usually reconnects by itself."
      >
        <span className={step}>
          <span className={bubble}>
            <Icon icon={PowerIcon} size={12} />
          </span>
          Turn it on
        </span>
      </Hint>
      <Icon
        className="text-muted-foreground/60"
        icon={ArrowRight01Icon}
        size={14}
      />
      <HintCard
        focusable
        content={
          <>
            <span className="block text-sm font-medium text-foreground">
              Still offline after a minute?
            </span>
            Run in Terminal on {computer.display_name}:
            <CommandLine command={`${computerCommand()} daemon start`} />
          </>
        }
      >
        <span className={step}>
          <span className={bubble}>
            <Icon icon={PlayIcon} size={12} />
          </span>
          Start the app
        </span>
      </HintCard>
      {onConnect ? (
        <>
          <Icon
            className="text-muted-foreground/60"
            icon={ArrowRight01Icon}
            size={14}
          />
          <Hint
            placement="bottom"
            text="Reset or replaced it? Connect it again."
          >
            <button className={step} onClick={onConnect} type="button">
              <span className={bubble}>
                <Icon icon={Link01Icon} size={12} />
              </span>
              Reconnect
            </button>
          </Hint>
        </>
      ) : null}
    </div>
  );
}

function Group({
  children,
  count,
  defaultOpen = true,
  hint,
  summary,
  title,
  trailing,
}: {
  children: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  hint?: string;
  /** A short tally after the title, such as how many Agents are offline. */
  summary?: string;
  title: string;
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label={title} className="mt-6">
      <div className="flex h-7 items-center gap-1.5 px-1 text-sm text-muted-foreground">
        <button
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-md transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <Icon
            className={cn(
              "transition-transform duration-200 motion-reduce:transition-none",
              !open && "-rotate-90",
            )}
            icon={ArrowDown01Icon}
            size={14}
          />
          {title}
          {count === undefined ? null : (
            <span className="text-xs tabular-nums">{count}</span>
          )}
        </button>
        {summary ? <span className="text-xs">· {summary}</span> : null}
        {hint ? (
          <Hint focusable placement="bottom" text={hint}>
            <span className="inline-flex text-muted-foreground/60">
              <Icon icon={InformationCircleIcon} size={14} />
            </span>
          </Hint>
        ) : null}
        <span className="flex-1" />
        {trailing}
      </div>
      {open ? <div className="mt-1 grid gap-1">{children}</div> : null}
    </section>
  );
}

function MarkDot({ tone }: { tone: "neutral" | "warning" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-background",
        tone === "warning" ? "bg-app-warning" : "bg-muted-foreground/50",
      )}
    />
  );
}

function AppRow({
  app,
  computer,
  onSetUp,
  online,
}: {
  app: TeamHubLocalRuntimeType;
  computer: LocalComputer;
  onSetUp: () => void;
  online: boolean;
}) {
  const runtime = computer.runtimes.find((item) => item.type === app);
  const status = runtime?.status ?? "not_installed";
  const name = appNames[app];
  const hint =
    [name, runtime?.version].filter(Boolean).join(" ") +
    ` · ${appDescriptions[app]}`;
  if (status === "not_installed")
    return (
      <ComputerRow
        action={
          online ? (
            <Button onClick={onSetUp} size="compact" tone="secondary">
              Add
            </Button>
          ) : null
        }
        hint={`${appDescriptions[app]} · optional`}
        // The app's own mark, faded: the plus is the Add button's job.
        mark={
          <RowMark dashed>
            <Icon
              className="text-muted-foreground opacity-60"
              icon={appIcons[app]}
              size={20}
            />
          </RowMark>
        }
        subtitle="Not installed"
        title={<span className="text-muted-foreground">{name}</span>}
      />
    );
  const subtitle = !online
    ? {
        authentication_required: "Last seen signed out",
        error: "Last check failed",
        incompatible: "Last seen outdated",
        ready: "Last seen ready",
        unknown: "Not checked yet",
      }[status]
    : {
        authentication_required: "Signed out",
        error: "Couldn't check",
        incompatible: "Update needed",
        ready: "Ready",
        unknown: "Couldn't check",
      }[status];
  const action = !online ? null : status === "ready" ? (
    <Icon className="text-app-success" icon={Tick02Icon} size={16} />
  ) : status === "authentication_required" ? (
    <Button onClick={onSetUp} size="compact">
      Sign in
    </Button>
  ) : status === "incompatible" ? (
    <Button onClick={onSetUp} size="compact">
      Update
    </Button>
  ) : (
    <RuntimeCheckCard app={app} computer={computer} focusable>
      <span className="inline-flex text-muted-foreground">
        <Icon icon={InformationCircleIcon} size={16} />
      </span>
    </RuntimeCheckCard>
  );
  return (
    <ComputerRow
      action={action}
      dimmed={!online}
      hint={hint}
      mark={
        <>
          <RowMark>
            <Icon icon={appIcons[app]} size={20} />
          </RowMark>
          {online && status !== "ready" ? <MarkDot tone="warning" /> : null}
        </>
      }
      subtitle={subtitle}
      title={name}
    />
  );
}

function runtimeMessage(computer: LocalComputer, app: TeamHubLocalRuntimeType) {
  return (
    computer.runtimes.find((item) => item.type === app)?.message ??
    `Couldn't check ${appNames[app]}`
  );
}

/** Why an app could not be checked, with the command that checks it again. */
function RuntimeCheckCard({
  align,
  app,
  children,
  computer,
  focusable = false,
}: {
  align?: "start" | "end";
  app: TeamHubLocalRuntimeType;
  children: ReactNode;
  computer: LocalComputer;
  focusable?: boolean;
}) {
  return (
    <HintCard
      align={align}
      focusable={focusable}
      content={
        <>
          <span className="block text-sm font-medium text-foreground">
            {runtimeMessage(computer, app)}
          </span>
          Check again in Terminal on {computer.display_name}:
          <CommandLine command={`${computerCommand()} runtime check`} />
        </>
      }
    >
      {children}
    </HintCard>
  );
}

function WorkspaceRows({ computer }: { computer: LocalComputer }) {
  return computer.workspace_grants.map((grant) => (
    <ComputerRow
      hint="Where Agents keep their work on this computer"
      key={grant.grant_id}
      mark={
        <RowMark>
          <Icon icon={Folder01Icon} size={20} />
        </RowMark>
      }
      subtitle={
        grant.mode === "read-only"
          ? "Agents can view here"
          : "Agents can edit here"
      }
      title={grant.label}
    />
  ));
}

function AdvancedRows({
  computer,
  onRemove,
  onUpdate,
}: {
  computer: LocalComputer;
  onRemove?: () => void;
  onUpdate: () => void;
}) {
  const command = computerCommand();
  const tools: [IconSvgElement, string, string][] = [
    [Activity01Icon, "Status", `${command} daemon status`],
    [RefreshIcon, "Restart", `${command} daemon restart`],
    [Search01Icon, "Re-check", `${command} runtime check`],
    [Link01Icon, "Reconnect", `${command} login`],
    [StopIcon, "Stop", `${command} daemon stop`],
  ];
  const row = "flex min-h-11 items-center gap-3 px-2.5";
  const label = "w-28 shrink-0 text-sm text-muted-foreground";
  return (
    <>
      <div className={row}>
        <span className={label}>App</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-secondary-foreground">
            {computer.daemon_version ?? "Not reported"}
          </span>
          {computer.upgrade_required || isUpgradeRecommended(computer) ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--app-status-warning-surface)] px-2 py-0.5 text-xs text-app-warning"
              onClick={onUpdate}
              type="button"
            >
              <Icon icon={RefreshIcon} size={12} />
              {computer.recommended_version
                ? `${computer.recommended_version} available`
                : "Update"}
            </button>
          ) : null}
        </span>
      </div>
      <div className={row}>
        <span className={label}>Computer ID</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {computer.computer_id}
        </span>
      </div>
      <div className={cn(row, "items-start py-1.5")}>
        <span className={cn(label, "pt-1.5")}>Troubleshoot</span>
        <span className="flex flex-wrap gap-1">
          {tools.map(([icon, name, toolCommand]) => (
            <HintCard
              content={
                <>
                  <span className="block text-sm font-medium text-foreground">
                    {name}
                  </span>
                  Run in Terminal on {computer.display_name}:
                  <CommandLine command={toolCommand} />
                </>
              }
              key={name}
            >
              <Button tone="ghost">
                <Icon icon={icon} size={14} />
                {name}
              </Button>
            </HintCard>
          ))}
        </span>
      </div>
      {onRemove ? (
        <div className={row}>
          <span className={label} />
          <Button
            aria-label="Remove"
            className="-ml-3 border-transparent"
            onClick={onRemove}
            tone="danger"
          >
            <Icon icon={Delete02Icon} size={14} />
            Remove computer
          </Button>
        </div>
      ) : null}
    </>
  );
}

function UpgradeCommand({ platform }: { platform?: ComputerPlatform }) {
  const [selected, setSelected] = useState<ComputerPlatform | "">("");
  const target = selected || platform || "";
  return (
    <>
      <ComputerPlatformSelector value={target} onChange={setSelected} />
      {target ? (
        <>
          {target === "win32" ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Run in PowerShell on this Windows computer.
            </p>
          ) : null}
          <CommandLine command={computerInstallCommand(target)} key={target} />
        </>
      ) : null}
    </>
  );
}

function platformLabel(platform?: ComputerPlatform) {
  return platform
    ? { darwin: "macOS", linux: "Linux", win32: "Windows" }[platform]
    : null;
}
