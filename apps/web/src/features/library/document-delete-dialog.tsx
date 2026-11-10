import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";

export function DocumentDeleteDialog({
  error,
  onCancel,
  onConfirm,
  pending,
  title,
}: {
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
  title: string;
}) {
  return (
    <ModalDialog
      closeOnBackdrop={!pending}
      description={`${title} will be deleted from all Rooms and shared locations. It cannot currently be restored from the product.`}
      onClose={() => {
        if (!pending) onCancel();
      }}
      size="sm"
      title="Delete Document?"
      footer={
        <>
          <Button disabled={pending} onClick={onCancel} tone="secondary">
            Cancel
          </Button>
          <Button loading={pending} onClick={onConfirm} tone="danger">
            Delete
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
