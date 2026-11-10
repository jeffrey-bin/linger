import { DeleteAgentDialog } from "./members/delete-agent-dialog";
import { useAgentDeletion } from "./members/use-agent-deletion";

export function RoomNavAgentDeleteDialog({
  agentId,
  name,
  onClose,
  tenantId,
}: {
  agentId: string;
  name: string;
  onClose: () => void;
  tenantId: string;
}) {
  const deletion = useAgentDeletion(tenantId, agentId, onClose);
  return (
    <DeleteAgentDialog
      agentName={name}
      error={deletion.error?.message}
      isPending={deletion.isPending}
      onClose={onClose}
      onDelete={() => deletion.mutate()}
    />
  );
}
