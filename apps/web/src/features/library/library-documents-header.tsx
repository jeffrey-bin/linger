import {
  FileAddIcon,
  FileImportIcon,
  FolderAddIcon,
  FolderUploadIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { type RefObject, useRef } from "react";

import { ActionMenu } from "@/components/ui/action-menu";
import { Icon } from "@/components/ui/icon";

/** The Library heading with the New menu and its hidden file pickers. */
export function LibraryDocumentsHeader({
  createBusy,
  importRef,
  onCreateDocument,
  onImport,
  onImportPick,
  onNewFolder,
  onUploadFolder,
}: {
  createBusy: boolean;
  importRef: RefObject<HTMLInputElement | null>;
  onCreateDocument: () => void;
  onImport: (file: File) => void;
  onImportPick: () => void;
  onNewFolder: () => void;
  onUploadFolder: (files: File[]) => void;
}) {
  const folderInputRef = useRef<HTMLInputElement>(null);
  return (
    <header className="workspace-files-heading">
      <h2>Library</h2>
      <div className="ml-auto flex items-center gap-1">
        <input
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onImport(file);
          }}
          ref={importRef}
          type="file"
        />
        <input
          data-testid="library-folder-upload-input"
          hidden
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) onUploadFolder(files);
          }}
          ref={(input) => {
            folderInputRef.current = input;
            // React does not type the non-standard directory picker attribute.
            input?.setAttribute("webkitdirectory", "");
          }}
          type="file"
        />
        <ActionMenu
          buttonClassName="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground shadow-button transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          items={[
            {
              disabled: createBusy,
              icon: <Icon icon={FileAddIcon} size={16} />,
              label: "New file",
              onSelect: onCreateDocument,
            },
            {
              disabled: createBusy,
              icon: <Icon icon={FolderAddIcon} size={16} />,
              label: "New folder",
              onSelect: onNewFolder,
            },
            {
              disabled: createBusy,
              icon: <Icon icon={FileImportIcon} size={16} />,
              label: "Import",
              onSelect: onImportPick,
            },
            {
              disabled: createBusy,
              icon: <Icon icon={FolderUploadIcon} size={16} />,
              label: "Upload folder",
              onSelect: () => folderInputRef.current?.click(),
            },
          ]}
          label="Create in My pages"
          placement="bottom-end"
          trigger={
            <>
              <Icon icon={PlusSignIcon} size={16} />
              New
            </>
          }
        />
      </div>
    </header>
  );
}
