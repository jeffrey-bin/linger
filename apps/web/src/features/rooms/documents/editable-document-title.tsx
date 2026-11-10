import { useCallback, useRef, useState } from "react";

export function EditableDocumentTitle({
  autoFocus = false,
  display = "breadcrumb",
  isEditing,
  name,
  onAutoFocusConsumed,
  onCommit,
  onRename,
}: {
  autoFocus?: boolean;
  display?: "breadcrumb" | "page";
  isEditing: boolean;
  name: string;
  onAutoFocusConsumed?: () => void;
  onCommit?: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(autoFocus);
  const [draft, setDraft] = useState<string>();
  const [committedName, setCommittedName] = useState<{
    base: string;
    next: string;
  }>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const shouldSelectOnFocusRef = useRef(autoFocus);
  const visibleName = committedName?.base === name ? committedName.next : name;
  const focusInput = useCallback(
    (element: HTMLInputElement | null) => {
      if (!element) return;
      element.focus();
      if (!shouldSelectOnFocusRef.current && !autoFocus) return;
      setEditing(true);
      shouldSelectOnFocusRef.current = false;
      const extensionIndex = visibleName.lastIndexOf(".");
      element.setSelectionRange(
        0,
        extensionIndex > 0 ? extensionIndex : visibleName.length,
      );
      onAutoFocusConsumed?.();
    },
    [autoFocus, onAutoFocusConsumed, visibleName],
  );
  const commit = useCallback(async () => {
    if (savingRef.current) return false;
    const next = (draft ?? visibleName).trim();
    if (!next || next === visibleName) {
      setEditing(false);
      return true;
    }
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    setCommittedName({ base: name, next });
    try {
      await onRename(next);
      setDraft(next);
      setEditing(false);
      return true;
    } catch (renameError) {
      setCommittedName(undefined);
      setError(
        renameError instanceof Error
          ? renameError.message
          : "The title could not be updated.",
      );
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [draft, name, onRename, visibleName]);
  const commitAndContinue = useCallback(async () => {
    if (!(await commit())) return;
    requestAnimationFrame(() => onCommit?.());
  }, [commit, onCommit]);
  if (!isEditing || !(editing || autoFocus)) {
    return (
      <div>
        <div
          className={
            display === "page"
              ? "block min-w-0 max-w-full text-left text-app-ink"
              : "min-w-0 truncate text-left text-sm font-semibold leading-5 text-app-ink"
          }
        >
          {isEditing ? (
            <button
              className="block min-w-0 max-w-full text-left text-app-ink"
              onClick={() => {
                setDraft(visibleName);
                setEditing(true);
              }}
              title="Rename document"
              type="button"
            >
              {display === "page" ? (
                <h1 className="room-document-page-title text-app-ink">
                  {visibleName}
                </h1>
              ) : (
                visibleName
              )}
            </button>
          ) : display === "page" ? (
            <h1 className="room-document-page-title text-app-ink">
              {visibleName}
            </h1>
          ) : (
            visibleName
          )}
        </div>
        {error ? (
          <span
            className={
              display === "page"
                ? "mt-2 block text-sm font-normal text-app-danger"
                : "sr-only"
            }
            role="alert"
          >
            {error}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <form
      className={display === "page" ? "w-full" : "min-w-0"}
      onSubmit={(event) => {
        event.preventDefault();
        void commitAndContinue();
      }}
    >
      <input
        aria-label="Document title"
        className={
          display === "page"
            ? "room-document-page-title block h-auto w-full min-w-0 border-0 bg-transparent px-0 py-0 font-normal text-app-ink outline-none shadow-none focus:border-0 focus:outline-none focus:ring-0"
            : "h-8 w-[min(360px,42vw)] border-0 bg-transparent px-0 text-sm font-semibold leading-5 text-app-ink outline-none shadow-none focus:border-0 focus:outline-none focus:ring-0"
        }
        disabled={saving}
        maxLength={255}
        onBlur={() => void commit()}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void commitAndContinue();
        }}
        ref={focusInput}
        value={draft ?? visibleName}
      />
      {error ? (
        <span
          className={
            display === "page"
              ? "mt-2 block text-sm font-normal text-app-danger"
              : "sr-only"
          }
          role="alert"
        >
          {error}
        </span>
      ) : null}
    </form>
  );
}
