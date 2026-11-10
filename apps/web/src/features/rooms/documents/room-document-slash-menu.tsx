import {
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
} from "@blocknote/core/extensions";
import {
  getDefaultReactSlashMenuItems,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { WorkflowSquare01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";

import { insertTableCellList } from "./room-document-table-list";
import type { RoomDocumentEditor } from "./room-document-blocknote-editor";

export function getRoomDocumentSlashMenuItems(
  editor: RoomDocumentEditor,
): DefaultReactSuggestionItem[] {
  return [
    ...getDefaultReactSlashMenuItems(editor).map((item) => {
      const kind =
        item.title === editor.dictionary.slash_menu.bullet_list.title
          ? "bullet"
          : item.title === editor.dictionary.slash_menu.numbered_list.title
            ? "numbered"
            : null;
      if (!kind) return item;
      return {
        ...item,
        onItemClick: () => {
          if (!insertTableCellList(editor, kind)) item.onItemClick();
        },
      };
    }),
    {
      aliases: ["diagram", "graph", "mmd"],
      group: "Other",
      icon: <Icon icon={WorkflowSquare01Icon} />,
      onItemClick: () =>
        insertOrUpdateBlockForSlashMenu(editor, {
          props: { language: "mermaid" },
          type: "codeBlock",
        }),
      subtext: "Create an editable Mermaid diagram",
      title: "Mermaid diagram",
    },
  ];
}

export function filterRoomDocumentSlashMenuItems(
  editor: RoomDocumentEditor,
  query: string,
) {
  const items = getRoomDocumentSlashMenuItems(editor);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery === "") return items;

  const titleMatches = items.filter((item) =>
    item.title.toLocaleLowerCase().includes(normalizedQuery),
  );
  return titleMatches.length > 0
    ? titleMatches
    : filterSuggestionItems(items, normalizedQuery);
}
