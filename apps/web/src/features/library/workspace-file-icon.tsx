import {
  Doc02Icon,
  Folder01Icon,
  File01Icon,
  FileAudioIcon,
  FileCodeIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileVideoIcon,
  FileZipIcon,
  Pdf02Icon,
  Ppt02Icon,
} from "@hugeicons/core-free-icons";

import { Icon } from "@/components/ui/icon";
import {
  artifactFileKind,
  type ArtifactFileKind,
} from "@/features/rooms/files/artifact-file-kind";

const icons = {
  pdf: { icon: Pdf02Icon, tone: "bg-sun-500/15 text-sun-700" },
  presentation: { icon: Ppt02Icon, tone: "bg-acorn-500/15 text-acorn-700" },
  word: { icon: Doc02Icon, tone: "bg-bluebell-500/15 text-bluebell-700" },
  spreadsheet: {
    icon: FileSpreadsheetIcon,
    tone: "bg-grass-500/15 text-grass-700",
  },
  code: { icon: FileCodeIcon, tone: "bg-lavender-500/15 text-lavender-700" },
  image: {
    icon: FileImageIcon,
    tone: "bg-bubblegum-500/15 text-bubblegum-700",
  },
  audio: { icon: FileAudioIcon, tone: "bg-lake-500/15 text-lake-700" },
  video: { icon: FileVideoIcon, tone: "bg-rain-500/15 text-rain-700" },
  archive: { icon: FileZipIcon, tone: "bg-butter-500/15 text-butter-700" },
  document: { icon: File01Icon, tone: "bg-muted text-muted-foreground" },
};

// Presentation mapping only; file capabilities and filter categories remain unchanged.
function iconKind(
  filename: string,
  mediaType?: string,
  explicitKind?: ArtifactFileKind,
): keyof typeof icons {
  if (/\.(doc|docx)$/i.test(filename)) return "word";
  if (/\.(aiff|aif)$/i.test(filename)) return "audio";
  if (/\.(3gp|rmvb)$/i.test(filename)) return "video";
  const kind = explicitKind ?? artifactFileKind(filename, mediaType);
  if (kind === "markdown" || kind === "html") return "code";
  return kind === "workflow" ? "document" : kind;
}

// Icon colors. The color only varies the look from file to file; the icon's
// shape carries the type.
const tints = [
  "text-sun-500",
  "text-acorn-500",
  "text-bluebell-500",
  "text-grass-500",
  "text-lavender-500",
  "text-bubblegum-500",
  "text-lake-500",
  "text-butter-500",
];

function tintFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return tints[hash % tints.length]!;
}

/**
 * A file in a chat Message: the type's line icon (PDF, slides, sheet,
 * image…), its lines colored by file name, with no tile behind it so the
 * file card holds no box inside its box.
 */
export function FileTypeIcon({
  filename,
  folder = false,
  kind: explicitKind,
  mediaType,
}: {
  filename: string;
  folder?: boolean;
  kind?: ArtifactFileKind;
  mediaType?: string;
}) {
  const kind = iconKind(filename, mediaType, explicitKind);
  return (
    <span
      aria-hidden="true"
      className={`flex size-10 shrink-0 items-center justify-center ${tintFor(filename)}`}
      data-kind={folder ? "folder" : kind}
    >
      <Icon icon={folder ? Folder01Icon : icons[kind].icon} size={30} />
    </span>
  );
}

export function WorkspaceFileIcon({
  filename,
  compact = false,
  className = "",
  kind: explicitKind,
  mediaType,
}: {
  filename: string;
  compact?: boolean;
  className?: string;
  kind?: ArtifactFileKind;
  mediaType?: string;
}) {
  const kind = iconKind(filename, mediaType, explicitKind);
  const icon = icons[kind];
  return (
    <span
      aria-hidden="true"
      className={`workspace-file-icon ${icon.tone} ${className}`}
      data-kind={kind}
      data-compact={compact || undefined}
    >
      <Icon icon={icon.icon} size={16} />
    </span>
  );
}
