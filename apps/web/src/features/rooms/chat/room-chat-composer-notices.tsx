import { Button } from "@/components/ui/button";

interface RoomChatComposerNoticesProps {
  agentDirectoryError: boolean;
  onRetryAgents: () => void;
}

export function RoomChatComposerNotices({
  agentDirectoryError,
  onRetryAgents,
}: RoomChatComposerNoticesProps) {
  return agentDirectoryError ? (
    <div
      className="room-readable mt-1.5 flex items-center justify-between gap-3 px-1 text-xs text-app-muted"
      role="alert"
    >
      <span>Your agents are unavailable</span>
      <Button onClick={onRetryAgents} size="compact" tone="secondary">
        Retry
      </Button>
    </div>
  ) : null;
}
