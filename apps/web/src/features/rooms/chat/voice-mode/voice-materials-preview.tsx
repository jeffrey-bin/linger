import {
  Cancel01Icon,
  File01Icon,
  Message01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useOptionalVoiceMaterials } from "./voice-materials-context";

/** Compact chips for material waiting to go out with the next message. */
export function VoiceMaterialsPreview() {
  const context = useOptionalVoiceMaterials();
  if (!context || (!context.materials.length && !context.error)) return null;
  return (
    <div aria-label="Selected voice materials" className="mb-1.5 px-1">
      <div className="flex flex-wrap gap-1.5">
        {context.materials.map((material) => {
          const materialIcon = material.messageId ? Message01Icon : File01Icon;
          return (
            <span
              key={material.id}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-app-border bg-app-surface-soft py-0.5 pl-2 pr-0.5 text-xs text-app-muted"
              title={material.quote || material.title}
            >
              <Icon icon={materialIcon} size={12} className="shrink-0" />
              <span className="max-w-64 truncate">
                {material.quote || material.title}
              </span>
              <Button
                aria-label={`Remove selection from ${material.title}`}
                onClick={() => context.remove(material.id)}
                size="compactIcon"
                tone="ghost"
              >
                <Icon icon={Cancel01Icon} size={12} />
              </Button>
            </span>
          );
        })}
      </div>
      {context.error ? (
        <p role="alert" className="mt-1 text-xs text-app-danger">
          {context.error}
        </p>
      ) : null}
    </div>
  );
}
