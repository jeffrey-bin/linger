import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";

import { useHideMeeting } from "./memory-queries";

/** Confirms deleting a meeting from the caller's own Meetings. */
export function HideMeetingDialog({
  captureId,
  name,
  onClose,
  onHidden,
  tenantId,
}: {
  captureId: string;
  /** How the meeting is named in the list, e.g. "Meeting Oct 1, 09:05". */
  name: string;
  onClose: () => void;
  onHidden?: () => void;
  tenantId: string;
}) {
  const hide = useHideMeeting(tenantId);
  return (
    <ModalDialog
      description={
        <>
          <strong>{name}</strong> will no longer show in your Meetings. Others
          who can see it keep it.
        </>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            loading={hide.isPending}
            onClick={() =>
              hide.mutate(captureId, {
                onSuccess: () => {
                  onClose();
                  onHidden?.();
                },
              })
            }
            tone="danger"
          >
            Delete
          </Button>
        </>
      }
      onClose={onClose}
      size="sm"
      title="Delete meeting"
    >
      {hide.isError ? (
        <p className="px-5 py-4 text-sm text-app-danger" role="alert">
          Couldn’t delete the meeting. Try again.
        </p>
      ) : null}
    </ModalDialog>
  );
}
