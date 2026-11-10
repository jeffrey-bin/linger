import { Message01Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";

/** Invites the first Message in a Room that has none. */
export function MessageTimelineEmptyState() {
  return (
    <div className="text-center">
      <span className="mx-auto flex size-11 items-center justify-center rounded-lg bg-app-rail text-app-muted">
        <Icon icon={Message01Icon} size={20} />
      </span>
      <h2 className="mt-4 text-base font-semibold">Start the conversation</h2>
      <p className="mt-1 text-sm text-app-muted">
        Messages are shared with every current Room member.
      </p>
    </div>
  );
}

export function LoadingOlderMessages() {
  return (
    <div
      aria-label="Loading earlier Messages"
      className="mb-5 flex justify-center text-app-muted"
      role="status"
    >
      <Spinner />
    </div>
  );
}
