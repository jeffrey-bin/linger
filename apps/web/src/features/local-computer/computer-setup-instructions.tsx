import {
  ComputerTerminal01Icon,
  Copy01Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { writeClipboardText } from "@/lib/clipboard";
import {
  browserComputerPlatform,
  computerCommand,
  computerInstallCommand,
  ComputerPlatformSelector,
} from "./computer-platform";

export function ComputerSetupInstructions({
  connected = false,
  waitingForNewComputer = false,
}: ComputerSetupInstructionsProps) {
  const [platform, setPlatform] = useState(browserComputerPlatform);
  const installCommand = computerInstallCommand(platform);

  return (
    <section
      aria-label="Connect a Local Computer"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="border-b border-border p-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-card text-foreground shadow-outline">
            <Icon icon={ComputerTerminal01Icon} size={16} />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Connect a computer
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {platform === "win32"
                ? "Run these commands in PowerShell on the computer you want to connect."
                : "Run these commands in a terminal on the computer you want to connect."}
            </p>
          </div>
        </div>
        <ComputerPlatformSelector value={platform} onChange={setPlatform} />
      </div>
      <ol className="divide-y divide-border px-4">
        <SetupStep
          key={platform}
          command={installCommand}
          number="1"
          title="Install CLI"
        />
        <SetupStep
          command={`${computerCommand()} login`}
          number="2"
          title="Connect computer"
        />
        <li className="flex gap-3 py-3.5">
          <StepNumber>3</StepNumber>
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-sm font-medium text-foreground">
              {connected
                ? "Computer connected"
                : waitingForNewComputer
                  ? "Waiting for a new computer"
                  : "Waiting for your computer"}
            </p>
            <p
              className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"
              role="status"
            >
              {connected ? (
                <Icon icon={Tick02Icon} size={14} />
              ) : (
                <Icon
                  icon={Loading03Icon}
                  className="animate-spin motion-reduce:animate-none"
                  size={14}
                />
              )}
              {connected ? (
                "Computer is online. Check its Runtime status before running tasks."
              ) : (
                <span className="town-shimmer-text">
                  {waitingForNewComputer
                    ? "Checking for a new Local Computer..."
                    : "Checking for an online Local Computer..."}
                </span>
              )}
            </p>
          </div>
        </li>
      </ol>
    </section>
  );
}

interface ComputerSetupInstructionsProps {
  connected?: boolean;
  waitingForNewComputer?: boolean;
}

function SetupStep({
  command,
  number,
  title,
}: {
  command: string;
  number: string;
  title: string;
}) {
  const commandRef = useRef<HTMLElement>(null);

  return (
    <li className="flex gap-3 py-3.5">
      <StepNumber>{number}</StepNumber>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2.5 py-2">
          <code
            className="workspace-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground"
            ref={commandRef}
          >
            {command}
          </code>
          <CopyValueButton selectionTargetRef={commandRef} value={command} />
        </div>
      </div>
    </li>
  );
}

function StepNumber({ children }: { children: ReactNode }) {
  return (
    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-semibold text-muted-foreground">
      {children}
    </span>
  );
}

export function CopyValueButton({
  selectionTargetRef,
  value,
}: {
  selectionTargetRef: RefObject<HTMLElement | null>;
  value: string;
}) {
  const [copyState, setCopyState] = useState<
    "idle" | "copied" | "selected" | "failed"
  >("idle");
  const resetTimer = useRef<number | undefined>(undefined);
  const copied = copyState === "copied";
  const selected = copyState === "selected";

  useEffect(
    () => () => {
      window.clearTimeout(resetTimer.current);
    },
    [],
  );

  return (
    <>
      <button
        aria-label={
          copied
            ? "Command copied"
            : selected
              ? "Command selected"
              : "Copy command"
        }
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          void (async () => {
            if (!(await copyText(value))) {
              window.clearTimeout(resetTimer.current);
              setCopyState(
                selectElementText(selectionTargetRef.current)
                  ? "selected"
                  : "failed",
              );
              resetTimer.current = window.setTimeout(
                () => setCopyState("idle"),
                3_000,
              );
              return;
            }

            window.clearTimeout(resetTimer.current);
            setCopyState("copied");
            resetTimer.current = window.setTimeout(
              () => setCopyState("idle"),
              1_500,
            );
          })();
        }}
        title={
          copied ? "Copied" : selected ? "Command selected" : "Copy command"
        }
        type="button"
      >
        {copied ? (
          <Icon icon={Tick02Icon} size={14} />
        ) : (
          <Icon icon={Copy01Icon} size={14} />
        )}
      </button>
      {copyState !== "idle"
        ? createPortal(
            <div
              aria-live="polite"
              className="pointer-events-none fixed bottom-5 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-popover px-4 py-2.5 text-sm text-foreground shadow-lg"
              role={copyState === "failed" ? "alert" : "status"}
            >
              {copied ? <Icon icon={Tick02Icon} size={14} /> : null}
              {copied
                ? "Copied to clipboard"
                : selected
                  ? "Command selected. Press Cmd+C or Ctrl+C to copy."
                  : "Copy is unavailable on this connection."}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

async function copyText(value: string): Promise<boolean> {
  try {
    await writeClipboardText(value);
    return true;
  } catch {
    return false;
  }
}

function selectElementText(target: HTMLElement | null): boolean {
  const selection = window.getSelection();
  if (!selection || !target) {
    return false;
  }

  const range = document.createRange();
  range.selectNodeContents(target);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection.toString() === target.textContent;
}
