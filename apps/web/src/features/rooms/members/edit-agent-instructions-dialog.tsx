import { type FormEvent, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";

import {
  presentAgentInstructions,
  UNSET_AGENT_INSTRUCTIONS,
} from "./agent-instruction-text";

export function EditAgentInstructionsDialog({
  instructions,
  canEdit,
  error,
  isPending,
  onClose,
  onSave,
}: {
  instructions: string;
  canEdit: boolean;
  error?: string;
  isPending: boolean;
  onClose: () => void;
  onSave: (input: { instructions: string }) => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState(() =>
    presentAgentInstructions(instructions),
  );
  const disabled = !canEdit || isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !draft.trim()) return;
    onSave({ instructions: draft });
  }

  return (
    <ModalDialog
      description="Define how your Agent should work and respond."
      onClose={onClose}
      size="md"
      title="Edit instructions"
      footer={
        <>
          <Button onClick={onClose} type="button">
            {canEdit ? "Cancel" : "Close"}
          </Button>
          {canEdit ? (
            <Button
              disabled={disabled || !draft.trim()}
              form={formId}
              loading={isPending}
              tone="primary"
              type="submit"
            >
              Save
            </Button>
          ) : null}
        </>
      }
    >
      <form className="px-5 py-4" id={formId} onSubmit={submit}>
        <textarea
          aria-label="Agent instructions"
          className="min-h-64 w-full resize-y rounded-md border border-border bg-card px-3 py-2.5 text-sm leading-6 text-foreground outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground hover:border-border-hover focus:border-foreground focus:ring-2 focus:ring-ring disabled:opacity-60"
          disabled={disabled}
          maxLength={50000}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={UNSET_AGENT_INSTRUCTIONS}
          value={draft}
        />
        {error ? (
          <p className="mt-3 text-sm text-app-danger" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </ModalDialog>
  );
}
