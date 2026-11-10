import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { DropdownOption, DropdownOptions } from "./dropdown-options";
import type { SelectItemProps } from "./select";
import {
  selectPopupContainingBlock,
  selectPopupFrame,
  selectPopupPosition,
} from "./select-popup-layout";

export function SelectPopup({
  id,
  onChoose,
  onClose,
  options,
  triggerRef,
  value,
}: {
  id: string;
  onChoose: (option: SelectItemProps) => void;
  onClose: (focusTrigger?: boolean) => void;
  options: SelectItemProps[];
  triggerRef: RefObject<HTMLButtonElement | null>;
  value: string;
}) {
  const listboxRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState({
    anchored: false,
    left: 0,
    side: "bottom" as "bottom" | "top",
    top: 0,
    width: 0,
  });
  const closePopup = useEffectEvent(onClose);
  const supportsPopover =
    typeof HTMLElement.prototype.showPopover === "function";

  useLayoutEffect(() => {
    const listbox = listboxRef.current;
    // Keep the DOM inside the modal for focus, but escape its clipping in the top layer.
    if (supportsPopover) listbox?.showPopover();
    function place() {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const portalRoot = trigger.closest("dialog") ?? document.body;
      const origin = supportsPopover
        ? null
        : selectPopupContainingBlock(portalRoot);
      const frame = selectPopupFrame(trigger.getBoundingClientRect(), origin, {
        height: window.innerHeight,
        width: window.innerWidth,
      });
      const next = selectPopupPosition(
        frame.trigger,
        frame.viewport,
        listboxRef.current?.offsetHeight,
      );
      setPosition({
        anchored: Boolean(origin),
        side: next.top < frame.trigger.top ? "top" : "bottom",
        ...next,
      });
    }

    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      if (supportsPopover) listbox?.hidePopover();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [options.length, position.width, supportsPopover, triggerRef]);

  useEffect(() => {
    const selected = options.findIndex((option) => option.value === value);
    const initial =
      selected >= 0
        ? selected
        : options.findIndex((option) => !option.disabled);
    requestAnimationFrame(() =>
      optionRefs.current[initial]?.focus({ preventScroll: true }),
    );
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !listboxRef.current?.contains(target)
      ) {
        closePopup();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [options, triggerRef, value]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key === "Tab") {
      onClose();
      return;
    }
    const direction =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const current = optionRefs.current.findIndex(
      (option) => option === document.activeElement,
    );
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index =
        (current + direction * offset + options.length) % options.length;
      if (!options[index]?.disabled) {
        optionRefs.current[index]?.focus();
        return;
      }
    }
  }

  const portalRoot = triggerRef.current?.closest("dialog") ?? document.body;

  return createPortal(
    <DropdownOptions
      className="z-[100] m-0 text-app-ink"
      data-select-portal=""
      data-side={position.side}
      id={id}
      onKeyDown={handleKeyDown}
      popover={supportsPopover ? "manual" : undefined}
      ref={listboxRef}
      role="listbox"
      style={{
        inset: "auto",
        left: position.left,
        position: position.anchored ? "absolute" : "fixed",
        top: position.top,
        // At least as wide as its trigger; long labels may widen it.
        ...(position.width > 0 ? { minWidth: position.width } : {}),
      }}
    >
      {options.map((option, index) => (
        <DropdownOption
          aria-label={
            typeof option.children === "string" ? option.children : undefined
          }
          aria-selected={option.value === value}
          disabled={option.disabled}
          key={option.value}
          onClick={() => onChoose(option)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onChoose(option);
            }
          }}
          ref={(node) => {
            optionRefs.current[index] = node;
          }}
          role="option"
          tabIndex={-1}
        >
          {option.children}
        </DropdownOption>
      ))}
    </DropdownOptions>,
    portalRoot,
  );
}
