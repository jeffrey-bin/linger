import {
  Add01Icon,
  AlertCircleIcon,
  ComputerTerminal01Icon,
  LaptopIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";

import { ComputerSetupInstructions } from "./computer-setup-instructions";
import { ServerConnection } from "./server-connection";

export function UnavailableComputer({
  onBack,
  onConnect,
}: {
  onBack: () => void;
  onConnect: () => void;
}) {
  return (
    <div className="flex min-h-full items-center justify-center px-6 py-12 text-center">
      <div className="max-w-md">
        <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon icon={AlertCircleIcon} size={20} />
        </span>
        <h1 className="mt-4 text-lg">Computer unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This Computer is offline or no longer available to your account.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button onClick={onBack} tone="primary">
            Back to computers
          </Button>
          <Button onClick={onConnect}>
            <Icon icon={ComputerTerminal01Icon} size={16} />
            Setup commands
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ConnectComputerDialog({
  tenantId,
  connected,
  onClose,
  onDone,
}: {
  tenantId?: string;
  connected: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <ModalDialog
      description="Install the CLI, then authorize this workspace from your terminal."
      onClose={onClose}
      size="md"
      title="Connect Local Computer"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button disabled={!connected} onClick={onDone} tone="primary">
            Done
          </Button>
        </>
      }
    >
      <div className="px-5 py-4">
        <ComputerSetupInstructions connected={connected} />
        {tenantId && <ServerConnection key={tenantId} tenantId={tenantId} />}
      </div>
    </ModalDialog>
  );
}

/** Every Computer was removed; the built-in local Computer normally prevents this. */
export function NoComputers({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex flex-col items-center pt-16 text-center">
      <span className="flex size-16 items-center justify-center rounded-[20%] bg-muted text-foreground">
        <Icon icon={LaptopIcon} size={28} />
      </span>
      <h2 className="mt-6 text-xl">Run Agents on your computer</h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        About 2 minutes to set up.
      </p>
      <Button className="mt-6" onClick={onConnect} tone="primary">
        <Icon icon={Add01Icon} size={14} />
        Connect a computer
      </Button>
    </div>
  );
}
