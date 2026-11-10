import { Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
} from "react";

import { Icon } from "@/components/ui/icon";

export type DialogSize = "sm" | "md" | "lg" | "xl";

const focusableSelector = [
  "button:not([disabled])",
  "[href]",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function firstFocusable(root: Element | null): HTMLElement | null {
  if (!root) {
    return null;
  }

  for (const element of root.querySelectorAll<HTMLElement>(focusableSelector)) {
    if (!element.closest("[inert]")) {
      return element;
    }
  }

  return null;
}

export function ModalDialog({
  ariaLabel,
  children,
  className = "",
  closeOnBackdrop = false,
  description,
  footer,
  onClose,
  size,
  title,
}: {
  /** Used when no `title` names the dialog; a titled dialog labels itself. */
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
  closeOnBackdrop?: boolean;
  /** Optional subtitle under the title. */
  description?: ReactNode;
  /** Right-aligned action row; omitted dialogs render no footer. */
  footer?: ReactNode;
  onClose: () => void;
  /** One of four standard widths; omit for a full-screen or custom frame. */
  size?: DialogSize;
  /** Rendering a title opts the dialog into the shared header/body/footer chrome. */
  title?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeFromBackdrop = useEffectEvent(() => onClose());
  const headingId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const standard = title !== undefined;

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (typeof dialog.showModal === "function") {
      if (!dialog.open) {
        dialog.showModal();
        // showModal focuses the header close button first; keep initial focus on the content.
        if (document.activeElement === closeButtonRef.current) {
          (
            firstFocusable(dialog.querySelector(".app-dialog-body")) ??
            firstFocusable(dialog.querySelector(".app-dialog-footer"))
          )?.focus();
        }
      }
    } else {
      dialog.setAttribute("open", "");
    }

    return () => {
      if (dialog.open && typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog || !closeOnBackdrop) {
      return;
    }

    const handleBackdropClick = (event: MouseEvent) => {
      if (event.target === dialog) closeFromBackdrop();
    };
    dialog.addEventListener("click", handleBackdropClick);
    return () => dialog.removeEventListener("click", handleBackdropClick);
  }, [closeOnBackdrop]);

  return (
    <dialog
      aria-label={standard ? undefined : ariaLabel}
      aria-labelledby={standard ? headingId : undefined}
      className={`app-dialog ${standard ? "app-dialog-standard" : ""} ${className}`}
      data-size={size}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      {standard ? (
        <>
          <header className="app-dialog-header">
            <div className="min-w-0 flex-1">
              <h2 className="app-dialog-title" id={headingId}>
                {title}
              </h2>
              {description !== undefined ? (
                <p className="app-dialog-description">{description}</p>
              ) : null}
            </div>
            <button
              aria-label="Close"
              className="app-dialog-close"
              ref={closeButtonRef}
              onClick={onClose}
              type="button"
            >
              <Icon icon={Cancel01Icon} size={16} />
            </button>
          </header>
          <div className="app-dialog-body">{children}</div>
          {footer !== undefined ? (
            <footer className="app-dialog-footer">{footer}</footer>
          ) : null}
        </>
      ) : (
        children
      )}
    </dialog>
  );
}
