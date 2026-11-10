import { UnderlineTabs } from "@/components/ui/underline-tabs";

export const workspaceTabs = [
  {
    empty: "No documents created by you",
    id: "owned",
    label: "My pages",
  },
  {
    empty: "No documents shared with you",
    id: "shared",
    label: "Shared with me",
  },
  { empty: "", id: "meetings", label: "Meetings" },
] as const;
export type WorkspaceTab = (typeof workspaceTabs)[number]["id"];

export function WorkspaceTabs({
  onChange,
  value,
}: {
  onChange: (tab: WorkspaceTab) => void;
  value: WorkspaceTab;
}) {
  return (
    <UnderlineTabs
      items={workspaceTabs}
      label="Library views"
      onChange={onChange}
      value={value}
    />
  );
}
