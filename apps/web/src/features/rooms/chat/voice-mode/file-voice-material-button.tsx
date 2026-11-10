import { QuoteDownIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useOptionalVoiceMaterials } from "./voice-materials-context";

/**
 * Offers a whole chat file as voice material while Voice Mode is on. Like the
 * text-selection action, it floats centred just below the card, and appears only while
 * the card (`group/file`) is hovered or the button has keyboard focus; touch
 * screens without hover always show it. Top padding, not margin, bridges the
 * gap so the pointer can travel from the card to the button.
 * Positioning lives on the wrapper because Button already carries `relative`.
 */
export function FileVoiceMaterialButton({
  documentId,
  filename,
  versionId,
}: {
  documentId: string;
  filename: string;
  versionId?: string;
}) {
  const materials = useOptionalVoiceMaterials();
  // Files need a Document grant, which only their own Room's composer gives.
  if (!materials?.voiceModeEntered || !materials.acceptsDocuments) return null;
  const added = materials.materials.some(
    (item) => item.documentId === documentId && !item.quote,
  );
  return (
    <span
      className="absolute left-1/2 top-full z-10 -translate-x-1/2 pt-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/file:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
      data-file-voice-material
    >
      <Button
        aria-label={
          added ? `${filename} added to voice` : `Add ${filename} to voice`
        }
        className="shadow-md"
        disabled={added}
        onClick={() =>
          materials.addSelection({
            documentId,
            quote: "",
            title: filename,
            ...(versionId ? { versionId } : {}),
          })
        }
        size="compact"
        tone="secondary"
        type="button"
      >
        {added ? (
          <Icon icon={Tick02Icon} size={14} />
        ) : (
          <Icon icon={QuoteDownIcon} size={14} />
        )}
        {added ? "Added to voice" : "Add to voice"}
      </Button>
    </span>
  );
}
