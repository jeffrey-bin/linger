export async function writeClipboardText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // A user gesture may still authorize the legacy browser copy command.
    }
  }
  const textarea = document.createElement("textarea");
  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  const activeTextControl =
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement
      ? activeElement
      : undefined;
  const activeSelection = activeTextControl
    ? {
        direction: activeTextControl.selectionDirection,
        end: activeTextControl.selectionEnd,
        start: activeTextControl.selectionStart,
      }
    : undefined;
  const selectedRanges = Array.from(
    { length: document.getSelection()?.rangeCount ?? 0 },
    (_, index) => document.getSelection()!.getRangeAt(index).cloneRange(),
  );
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  try {
    const fallbackContainer =
      activeElement?.closest("dialog[open]") ?? document.body;
    fallbackContainer.append(textarea);
    textarea.select();
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard is unavailable");
    }
  } finally {
    textarea.remove();
    try {
      if (activeElement?.isConnected) {
        activeElement.focus({ preventScroll: true });
      }
      if (
        activeTextControl &&
        activeSelection &&
        activeSelection.start !== null &&
        activeSelection.end !== null
      ) {
        activeTextControl.setSelectionRange(
          activeSelection.start,
          activeSelection.end,
          activeSelection.direction ?? undefined,
        );
      } else if (selectedRanges.length > 0) {
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selectedRanges.forEach((range) => selection?.addRange(range));
      }
    } catch {
      // Focus restoration is best-effort and must not hide the copy result.
    }
  }
}
