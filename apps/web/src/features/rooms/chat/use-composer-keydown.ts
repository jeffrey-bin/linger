import type { KeyboardEvent } from "react";

import type { ComposerDraft } from "./use-composer-draft";
import {
  adjacentMentionTab,
  adjacentSelectableIndex,
  type ComposerPicker,
} from "./use-composer-picker";
import type { ComposerReferenceInsertion } from "./use-composer-reference-insertion";
import type { ComposerSend } from "./use-composer-send";

export interface ComposerKeyDownInput {
  draft: ComposerDraft;
  insertion: ComposerReferenceInsertion;
  picker: ComposerPicker;
  sending: ComposerSend;
}

/** Picker navigation and Enter-to-send, deferring to an open IME composition. */
export function useComposerKeyDown({
  draft: { isComposing },
  insertion: { insertAtPickerItem, insertSkill },
  picker: {
    activeMentionIndex,
    activePickerLength,
    applyMentionQuery,
    atPickerItems,
    availableMentionTabs,
    matchingSkills,
    mentionQuery,
    mentionTab,
    selectablePickerIndices,
    setMentionSelection,
    setMentionTab,
    setSkillQuery,
    skillQuery,
  },
  sending: { send },
}: ComposerKeyDownInput) {
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isComposing.current || event.nativeEvent.isComposing) {
      return;
    }

    if ((mentionQuery || skillQuery) && activePickerLength) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionSelection(
          adjacentSelectableIndex(
            selectablePickerIndices,
            activeMentionIndex,
            1,
          ),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionSelection(
          adjacentSelectableIndex(
            selectablePickerIndices,
            activeMentionIndex,
            -1,
          ),
        );
        return;
      }
      if (
        (event.key === "Enter" && !event.shiftKey) ||
        (event.key === "Tab" && !event.shiftKey)
      ) {
        event.preventDefault();
        if (skillQuery) {
          insertSkill(matchingSkills[activeMentionIndex]!);
        } else {
          insertAtPickerItem(atPickerItems[activeMentionIndex]!);
        }
        return;
      }
    }

    if (
      mentionQuery &&
      mentionQuery.query.length === 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      setMentionTab(
        adjacentMentionTab(
          mentionTab,
          event.key === "ArrowRight" ? 1 : -1,
          availableMentionTabs,
        ),
      );
      setMentionSelection(0);
      return;
    }

    if (
      (mentionQuery || skillQuery) &&
      (event.key === "Home" ||
        event.key === "End" ||
        (Boolean(skillQuery) &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight")))
    ) {
      applyMentionQuery(null);
      setSkillQuery(null);
      return;
    }

    if (event.key === "Escape" && (mentionQuery || skillQuery)) {
      event.preventDefault();
      applyMentionQuery(null);
      setSkillQuery(null);
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void send();
  }

  return { handleKeyDown };
}
