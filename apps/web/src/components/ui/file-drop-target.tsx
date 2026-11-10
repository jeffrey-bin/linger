import { Upload04Icon } from "@hugeicons/core-free-icons";
import { type DragEventHandler, type ReactNode, useState } from "react";
import { Icon } from "@/components/ui/icon";

interface FileDropTargetProps {
  canAccept: () => boolean;
  children: ReactNode;
  className: string;
  /** Rings the whole drop area while a drag is active. */
  outlined?: boolean;
  /**
   * Called synchronously during the drop. The live DataTransfer lets a folder
   * drop read its directory entries before the event ends.
   */
  onFiles: (files: File[], transfer: DataTransfer) => void;
  subtitle?: string;
  testId: string;
  title: string;
}

/**
 * Accepts files dragged in from the operating system and shows a blurred
 * overlay while they hover. Drags without OS files (text, links, in-app tree
 * moves) pass through untouched.
 */
export function FileDropTarget({
  canAccept,
  children,
  className,
  outlined = false,
  onFiles,
  subtitle,
  testId,
  title,
}: FileDropTargetProps) {
  const fileDrop = useFileDrop({ canAccept, onFiles });

  return (
    <div className={className} data-testid={testId} {...fileDrop.targetProps}>
      {fileDrop.active ? (
        <FileDropOverlay
          outlined={outlined}
          subtitle={subtitle}
          title={title}
        />
      ) : null}
      {children}
    </div>
  );
}

function useFileDrop({
  canAccept,
  onFiles,
}: Pick<FileDropTargetProps, "canAccept" | "onFiles">) {
  const [active, setActive] = useState(false);

  function reset() {
    setActive(false);
  }

  const onDragEnter: DragEventHandler<HTMLDivElement> = (event) => {
    if (!hasFiles(event.dataTransfer) || !canAccept()) return;
    event.preventDefault();
    setActive(true);
  };

  const onDragOver: DragEventHandler<HTMLDivElement> = (event) => {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (!canAccept()) {
      event.dataTransfer.dropEffect = "none";
      reset();
      return;
    }
    event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave: DragEventHandler<HTMLDivElement> = (event) => {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    reset();
  };

  const onDrop: DragEventHandler<HTMLDivElement> = (event) => {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (!canAccept()) {
      reset();
      return;
    }

    const files = Array.from(event.dataTransfer.files ?? []);
    reset();
    if (files.length > 0) onFiles(files, event.dataTransfer);
  };

  return {
    active,
    targetProps: { onDragEnter, onDragLeave, onDragOver, onDrop },
  };
}

function FileDropOverlay({
  outlined,
  subtitle,
  title,
}: {
  outlined: boolean;
  subtitle?: string;
  title: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 z-40 flex items-center justify-center p-5 backdrop-blur-sm ${
        outlined
          ? "rounded-lg bg-primary/5 ring-2 ring-inset ring-primary/40"
          : "bg-background/20"
      }`}
      data-testid="file-drop-overlay"
    >
      <div className="town-drop-card flex min-h-[270px] w-[min(560px,86%)] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border-hover bg-card p-6 text-center shadow-lg">
        <span className="town-drop-icon flex size-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Icon icon={Upload04Icon} size={32} />
        </span>
        <strong className="text-base font-medium text-foreground">
          {title}
        </strong>
        {subtitle ? (
          <span className="text-xs text-app-muted">{subtitle}</span>
        ) : null}
      </div>
    </div>
  );
}

function hasFiles(dataTransfer: DataTransfer) {
  return (
    Array.from(dataTransfer.types ?? []).includes("Files") ||
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
  );
}
