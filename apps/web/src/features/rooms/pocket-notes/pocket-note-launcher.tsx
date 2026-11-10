import { lazy, Suspense, useRef, useState } from "react";
import { Icon, type IconSvgElement } from "@/components/ui/icon";

// The notepad loads on first open so the sidebar's initial bundle only
// carries this trigger.
const PocketNotePanel = lazy(() => import("./pocket-note-panel"));

const stroke = {
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: "1.5",
};
// A pencil writing a wavy line: no page outline, so it reads apart from the
// Meeting icon's paper. Drawn on Hugeicons' 24px grid with its 1.5 stroke.
const noteWriteIcon: IconSvgElement = [
  "M15.2 3.8C15.9 3.1 17.1 3.1 17.8 3.8L19.2 5.2C19.9 5.9 19.9 7.1 19.2 7.8L9.5 17.5L5 18.5L6 14L15.2 3.8Z",
  "M13.5 5.8L17.2 9.5",
  "M4 21.5C5.6 20.3 7 20.3 8.4 21.4C9.8 22.5 11.2 22.5 12.7 21.4C14.2 20.3 15.6 20.3 17 21.2",
].map((d, index) => ["path", { d, ...stroke, key: String(index) }]);

/**
 * Always-visible toolbar action opens today's Pocket Note, with all pages
 * one click away.
 */
export function PocketNoteLauncher({
  anotherMeRoomId,
  tenantId,
}: {
  anotherMeRoomId?: string;
  tenantId: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<(() => void) | undefined>(undefined);
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Pocket Notes"
        className="xs-nav-btn"
        onClick={() =>
          open ? (closeRef.current ?? (() => setOpen(false)))() : setOpen(true)
        }
        ref={triggerRef}
        title="Pocket Notes"
        type="button"
      >
        <Icon icon={noteWriteIcon} size={16} />
      </button>
      {open ? (
        <Suspense fallback={null}>
          <PocketNotePanel
            anchorRef={triggerRef}
            anotherMeRoomId={anotherMeRoomId}
            closeRef={closeRef}
            onClose={() => setOpen(false)}
            tenantId={tenantId}
          />
        </Suspense>
      ) : null}
    </>
  );
}
