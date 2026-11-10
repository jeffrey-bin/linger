import {
  InformationCircleIcon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import type {
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
} from "@/features/teamhub/teamhub-types";
import { cn } from "@/lib/cn";

import { appIcons } from "./computer-app-icons";
import { Hint } from "./computer-hint";
import { appNames, appOrder, appStatus } from "./computer-readiness";
import { CopyValueButton } from "./computer-setup-instructions";
import { installCommand, loginCommands } from "./local-runtime-commands";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

const readyCloseDelayMs = 1_200;

/**
 * Installs and signs in to one AI app on a Computer. The browser cannot run
 * commands there, so each step hands over a command and the live inventory
 * moves the steps forward.
 */
export function AppSetupDialog({
  app: initialApp,
  choosable = false,
  computer,
  onClose,
}: {
  app: TeamHubLocalRuntimeType;
  /** Lets the user pick which app to set up when none is installed yet. */
  choosable?: boolean;
  computer: LocalComputer;
  onClose: () => void;
}) {
  const [app, setApp] = useState(initialApp);
  const [waiting, setWaiting] = useState(false);
  const status = appStatus(computer, app);
  const outdated = status === "incompatible";
  // An incompatible app reinstalls through the same install command.
  const installed = status !== "not_installed" && !outdated;
  const ready = status === "ready";
  const online = computer.status === "online";
  const name = appNames[app];
  // Only an app that becomes ready while the dialog is open closes it.
  const [readyWhenShown, setReadyWhenShown] = useState(ready);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!ready || readyWhenShown) return;
    const timer = window.setTimeout(
      () => onCloseRef.current(),
      readyCloseDelayMs,
    );
    return () => window.clearTimeout(timer);
  }, [ready, readyWhenShown]);

  const login = loginCommands[app];
  const install = installCommand(app, computer.platform);
  const current = ready ? null : installed ? "signIn" : "install";

  return (
    <ModalDialog
      footer={
        <>
          <span
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 text-xs",
              ready ? "text-app-success" : "text-muted-foreground",
            )}
            role="status"
          >
            {!online ? (
              `${computer.display_name} is offline`
            ) : ready ? (
              <>
                <Icon icon={Tick02Icon} size={14} />
                {name} is ready
              </>
            ) : waiting ? (
              <>
                <Icon
                  className="animate-spin motion-reduce:animate-none"
                  icon={Loading03Icon}
                  size={14}
                />
                <span className="town-shimmer-text">Checking {name}…</span>
              </>
            ) : null}
          </span>
          <Button onClick={onClose}>Close</Button>
        </>
      }
      onClose={onClose}
      size="lg"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Icon icon={appIcons[app]} size={16} />
          {outdated
            ? `Update ${name}`
            : installed
              ? `Sign in to ${name}`
              : `Set up ${name}`}
          <Hint
            focusable
            className="text-muted-foreground/70"
            placement="bottom"
            text={`On ${computer.display_name}, in the same account you used to connect it.`}
          >
            <span className="inline-flex">
              <Icon icon={InformationCircleIcon} size={14} />
            </span>
          </Hint>
        </span>
      }
    >
      <div className="px-5 py-4">
        {choosable ? (
          <div className="mb-4 inline-flex rounded-full bg-muted p-0.5">
            {appOrder.map((option) => (
              <button
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors duration-150",
                  option === app
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={option}
                onClick={() => {
                  setApp(option);
                  setReadyWhenShown(appStatus(computer, option) === "ready");
                  setWaiting(false);
                }}
                type="button"
              >
                <Icon icon={appIcons[option]} size={14} />
                {appNames[option]}
              </button>
            ))}
          </div>
        ) : null}
        <ol className="grid grid-cols-3 gap-3">
          <VisualStep
            label="Install"
            number={1}
            state={installed ? "done" : "current"}
          >
            <MiniTerminal command={install} />
          </VisualStep>
          <VisualStep
            hint={
              app === "pi"
                ? "Then type /login in Pi"
                : "A sign-in page opens in your browser"
            }
            label="Sign in"
            number={2}
            state={ready ? "done" : installed ? "current" : "todo"}
          >
            <div className="grid w-full justify-items-center gap-2">
              <MiniTerminal command={login} />
              <MiniWindow>
                <Icon icon={appIcons[app]} size={14} />
                <span className="rounded-md bg-primary px-2.5 py-0.5 text-[12px] font-medium text-primary-foreground">
                  Sign in
                </span>
              </MiniWindow>
            </div>
          </VisualStep>
          <VisualStep label="Ready" number={3} state={ready ? "done" : "todo"}>
            <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-card pr-2.5 pl-2 text-xs shadow-outline">
              <Icon icon={appIcons[app]} size={14} />
              {name}
              {ready ? <StepTick /> : null}
            </span>
          </VisualStep>
        </ol>
        {current ? (
          <div className="mt-4">
            <p className="text-xs text-muted-foreground">
              {current === "install"
                ? `Paste into Terminal on ${computer.display_name}`
                : "Run this, then sign in on the page that opens"}
            </p>
            <CommandLine
              command={current === "install" ? install : login}
              onCopy={() => setWaiting(true)}
            />
          </div>
        ) : null}
      </div>
    </ModalDialog>
  );
}

function VisualStep({
  children,
  hint,
  label,
  number,
  state,
}: {
  children: ReactNode;
  hint?: string;
  label: string;
  number: number;
  state: "current" | "done" | "todo";
}) {
  return (
    <li className="min-w-0">
      <div
        className={cn(
          "grid h-32 place-items-center overflow-hidden rounded-xl bg-muted px-3",
          state === "current" && "shadow-[inset_0_0_0_1.5px_var(--app-ink)]",
        )}
      >
        <div
          className={cn(
            "grid w-full justify-items-center",
            state === "done" && "opacity-45",
          )}
        >
          {children}
        </div>
      </div>
      <p
        className={cn(
          "mt-2.5 flex items-center gap-2 text-sm",
          state === "current" ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold",
            state === "done"
              ? "bg-app-success text-white"
              : state === "current"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground",
          )}
        >
          {state === "done" ? <Icon icon={Tick02Icon} size={12} /> : number}
        </span>
        {label}
        {hint ? (
          <Hint focusable text={hint}>
            <span className="inline-flex text-muted-foreground/60">
              <Icon icon={InformationCircleIcon} size={14} />
            </span>
          </Hint>
        ) : null}
      </p>
    </li>
  );
}

function MiniTerminal({ command }: { command: string }) {
  return (
    <div className="w-full overflow-hidden rounded-lg bg-card shadow-sm">
      <WindowDots />
      <code className="block truncate px-2.5 pt-0.5 pb-2 text-[12px] text-foreground">
        <span className="text-muted-foreground">$ </span>
        {command}
      </code>
    </div>
  );
}

function MiniWindow({ children }: { children: ReactNode }) {
  return (
    <div className="w-3/4 overflow-hidden rounded-lg bg-card shadow-sm">
      <WindowDots />
      <div className="flex flex-col items-center gap-1.5 px-2 pt-0.5 pb-2.5">
        {children}
      </div>
    </div>
  );
}

function WindowDots() {
  return (
    <span aria-hidden className="flex h-4 items-center gap-1 px-2">
      <span className="size-1.5 rounded-full bg-border-hover" />
      <span className="size-1.5 rounded-full bg-border-hover" />
      <span className="size-1.5 rounded-full bg-border-hover" />
    </span>
  );
}

function StepTick() {
  return (
    <span className="flex size-3.5 items-center justify-center rounded-full bg-app-success text-white">
      <Icon icon={Tick02Icon} size={10} />
    </span>
  );
}

/** A command with its copy button; `onCopy` lets a step start waiting. */
export function CommandLine({
  command,
  onCopy,
}: {
  command: string;
  onCopy?: () => void;
}) {
  const commandRef = useRef<HTMLElement>(null);
  return (
    <div
      className="mt-2 flex min-w-0 items-center gap-2 rounded-lg bg-muted px-3 py-1.5"
      onClickCapture={onCopy}
    >
      <code
        className="workspace-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground"
        ref={commandRef}
      >
        {command}
      </code>
      <CopyValueButton selectionTargetRef={commandRef} value={command} />
    </div>
  );
}
