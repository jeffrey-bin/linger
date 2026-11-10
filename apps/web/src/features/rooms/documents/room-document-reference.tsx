import { File01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";

export function RoomDocumentReference({
  documentId,
  href,
  label,
  tenantId,
}: {
  documentId: string;
  href: string;
  label: string;
  tenantId: string;
}) {
  return (
    <a
      className="room-document-reference"
      data-linger-document-id={documentId}
      data-linger-tenant-id={tenantId}
      href={href}
    >
      <Icon icon={File01Icon} />
      <span>{label}</span>
    </a>
  );
}
