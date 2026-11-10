import { lazy, Suspense } from "react";
import { Spinner } from "./ui/spinner";
import type { ReadOnlyBlockNoteDocumentProps } from "./read-only-blocknote-document";

const ReadOnlyBlockNoteDocument = lazy(() =>
  import("./read-only-blocknote-document").then((module) => ({
    default: module.ReadOnlyBlockNoteDocument,
  })),
);

export function ReadOnlyBlockNoteDocumentLoader(
  props: ReadOnlyBlockNoteDocumentProps,
) {
  return (
    <Suspense
      fallback={
        <div
          className="flex items-center gap-2 p-4 text-sm text-app-muted"
          role="status"
        >
          <Spinner size={16} />
          Loading document…
        </div>
      }
    >
      <ReadOnlyBlockNoteDocument {...props} />
    </Suspense>
  );
}
