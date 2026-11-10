import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";

export function DeleteAgentDialog({
  agentName,
  error,
  isPending,
  onClose,
  onDelete,
}: {
  agentName: string;
  error?: string;
  isPending: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  const title = `Remove ${agentName}?`;
  return (
    <ModalDialog
      description="The Agent will be removed from every Room and your direct chat with it will be deleted. Messages in shared Rooms stay available."
      onClose={() => {
        if (!isPending) onClose();
      }}
      size="sm"
      title={title}
      footer={
        <>
          <Button disabled={isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button loading={isPending} onClick={onDelete} tone="danger">
            Remove Agent
          </Button>
        </>
      }
    >
      {error ? (
        <p className="px-5 py-4 text-sm text-app-danger" role="alert">
          {error}
        </p>
      ) : null}
    </ModalDialog>
  );
}
