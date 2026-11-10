import type { QueryClient } from "@tanstack/react-query";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
export interface VoiceCommandOption {
  id: string;
  name: string;
}
export interface VoiceCommandContext {
  client: TeamHubClient;
  tenantId: string;
  /** The Room Voice Mode sends to. */
  roomId: string;
  queryClient: QueryClient | undefined;
  /** Ends Voice Mode once the current turn has settled. */
  exitVoiceMode: () => void;
}
