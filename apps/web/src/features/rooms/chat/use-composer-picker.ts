import { useId, useState } from "react";

import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import {
  findDocumentCandidates,
  findMessageSkillQuery,
  findSkillCandidates,
  type MessageDocumentOption,
  type MessageSkillOption,
  type MessageSkillQuery,
} from "./message-composer-references";
import {
  findMessageMentionCandidates,
  findMessageMentionQuery,
  type MessageMentionQuery,
} from "./message-mentions";
import type { ComposerDraft } from "./use-composer-draft";

/** Keeps the Docs candidate list bounded when the Tenant catalog is large. */
const MENTION_DOCUMENT_LIMIT = 50;
const mentionTabs = ["all", "people", "docs"] as const;
const peopleMentionTabs = ["all", "people"] as const;
export type MentionTab = (typeof mentionTabs)[number];

export type AtPickerItem =
  | { actor: TeamHubActorRef; kind: "actor" }
  | { document: MessageDocumentOption; kind: "document" };

export interface ComposerPickerInput {
  documentMentionsEnabled: boolean;
  draft: ComposerDraft;
  mentionOptions: TeamHubActorRef[];
  onDocumentQueryChange?: (query: string | null) => void;
  skillOptions: MessageSkillOption[];
}

/** The `@` mention picker and the `/` Skill picker opened from the caret. */
export function useComposerPicker({
  documentMentionsEnabled,
  draft: { documentOptions, selectedMentionsRef },
  mentionOptions,
  onDocumentQueryChange,
  skillOptions,
}: ComposerPickerInput) {
  const [mentionQuery, setMentionQuery] = useState<MessageMentionQuery | null>(
    null,
  );
  const [mentionSelection, setMentionSelection] = useState(0);
  const [mentionTab, setMentionTab] = useState<MentionTab>("all");
  const [skillQuery, setSkillQuery] = useState<MessageSkillQuery | null>(null);
  const mentionListId = useId();
  const matchingRoomMentions = findMessageMentionCandidates(
    mentionQuery,
    mentionOptions,
  );
  const matchingDocuments = findDocumentCandidates(
    mentionQuery,
    documentMentionsEnabled ? documentOptions : [],
  ).slice(0, MENTION_DOCUMENT_LIMIT);
  const availableMentionTabs = documentMentionsEnabled
    ? mentionTabs
    : peopleMentionTabs;
  const atPickerItems: AtPickerItem[] = [
    ...(mentionTab === "docs"
      ? []
      : matchingRoomMentions.map((actor) => ({
          actor,
          kind: "actor" as const,
        }))),
    ...(mentionTab === "people"
      ? []
      : matchingDocuments.map((document) => ({
          document,
          kind: "document" as const,
        }))),
  ];
  const matchingSkills = findSkillCandidates(skillQuery, skillOptions);
  const selectablePickerIndices = skillQuery
    ? matchingSkills.map((_, index) => index)
    : atPickerItems.flatMap((item, index) =>
        isAtPickerItemSelectable(item) ? [index] : [],
      );
  const activePickerLength = selectablePickerIndices.length;
  const activeMentionIndex = selectablePickerIndices.includes(mentionSelection)
    ? mentionSelection
    : (selectablePickerIndices[0] ?? 0);

  /** Opens or closes the `@` picker and reports the Document query to the owner. */
  function applyMentionQuery(nextMentionQuery: MessageMentionQuery | null) {
    setMentionQuery(nextMentionQuery);
    onDocumentQueryChange?.(
      documentMentionsEnabled && nextMentionQuery
        ? nextMentionQuery.query
        : null,
    );
  }

  function updateMentionQuery(nextBody: string, cursor: number) {
    const nextMentionQuery = findMessageMentionQuery(nextBody, cursor);
    applyMentionQuery(nextMentionQuery);
    const nextSkillQuery = nextMentionQuery
      ? null
      : findMessageSkillQuery(nextBody, cursor, selectedMentionsRef.current);
    setSkillQuery(
      nextSkillQuery &&
        skillOptions.some((skill) => skill.agent.id === nextSkillQuery.agent.id)
        ? nextSkillQuery
        : null,
    );
    setMentionSelection(0);
    setMentionTab("all");
  }

  function closePicker() {
    applyMentionQuery(null);
    setSkillQuery(null);
  }

  return {
    activeMentionIndex,
    activePickerLength,
    applyMentionQuery,
    atPickerItems,
    availableMentionTabs,
    closePicker,
    matchingSkills,
    mentionListId,
    mentionQuery,
    mentionTab,
    selectablePickerIndices,
    setMentionSelection,
    setMentionTab,
    setSkillQuery,
    skillQuery,
    updateMentionQuery,
  };
}

export type ComposerPicker = ReturnType<typeof useComposerPicker>;

export function adjacentSelectableIndex(
  indices: number[],
  current: number,
  direction: -1 | 1,
) {
  const position = Math.max(0, indices.indexOf(current));
  return indices[
    Math.min(indices.length - 1, Math.max(0, position + direction))
  ]!;
}

export function adjacentMentionTab(
  current: MentionTab,
  direction: -1 | 1,
  tabs: readonly MentionTab[],
) {
  const index = tabs.indexOf(current);
  return tabs[(index + direction + tabs.length) % tabs.length]!;
}

function isAtPickerItemSelectable(item: AtPickerItem) {
  return item.kind === "actor" || item.kind === "document";
}
