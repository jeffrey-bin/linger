import { useLayoutEffect, useRef, type RefObject } from "react";

const minimumHeight = 18;
const maximumHeight = 160;
const heightTransition = "height 160ms ease-out";
const mirroredProperties = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "text-indent",
  "tab-size",
  "direction",
  "word-break",
  "overflow-wrap",
  "white-space",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
] as const;

/** Text remains immediate; only the visible editor's measured height transitions. */
export function useVoiceModeTextareaLayout({
  active,
  text,
  textareaRef,
}: {
  active: boolean;
  text: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const latestText = useRef(text);
  const measureRef = useRef<
    ((value: string, animate: boolean) => void) | undefined
  >(undefined);
  useLayoutEffect(() => {
    latestText.current = text;
  }, [text]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!active || !textarea) return;
    const document = textarea.ownerDocument;
    const view = document.defaultView;
    if (!view) return;
    const mirror = document.createElement("textarea");
    mirror.dataset.voiceModeMeasure = "true";
    mirror.setAttribute("aria-hidden", "true");
    mirror.tabIndex = -1;
    mirror.readOnly = true;
    mirror.rows = 1;
    Object.assign(mirror.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      visibility: "hidden",
      pointerEvents: "none",
      height: "0px",
      minHeight: "0",
      maxHeight: "none",
      boxSizing: "border-box",
      border: "0",
      overflow: "hidden",
      resize: "none",
    });
    document.body.append(mirror);
    const previousStyle = {
      height: textarea.style.height,
      overflowY: textarea.style.overflowY,
      transition: textarea.style.transition,
    };
    const motion = view.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame: number | undefined;
    let initialized = false;
    let lastText: string | undefined;
    let lastWidth = -1;
    let observedWidth = -1;
    let followLatest =
      textarea.scrollHeight - textarea.clientHeight - textarea.scrollTop <= 4;
    let retainedScrollTop = textarea.scrollTop;
    let automaticScrollTop: number | undefined;
    const follow = () => {
      if (!followLatest) return;
      textarea.scrollTop = Math.max(
        0,
        textarea.scrollHeight - textarea.clientHeight,
      );
      automaticScrollTop = textarea.scrollTop;
      retainedScrollTop = textarea.scrollTop;
    };
    const scroll = () => {
      if (
        automaticScrollTop !== undefined &&
        textarea.scrollTop === automaticScrollTop
      ) {
        automaticScrollTop = undefined;
        return;
      }
      automaticScrollTop = undefined;
      retainedScrollTop = textarea.scrollTop;
      followLatest =
        textarea.scrollHeight - textarea.clientHeight - textarea.scrollTop <= 4;
    };
    const measure = (value: string, animate: boolean) => {
      const style = view.getComputedStyle(textarea);
      const pixels = (property: string) =>
        Number.parseFloat(style.getPropertyValue(property)) || 0;
      const borderHeight =
        pixels("border-top-width") + pixels("border-bottom-width");
      const borderWidth =
        pixels("border-left-width") + pixels("border-right-width");
      const width =
        textarea.clientWidth ||
        textarea.getBoundingClientRect().width - borderWidth;
      if (width <= 0 || (animate && value === lastText && width === lastWidth))
        return;
      for (const property of mirroredProperties)
        mirror.style.setProperty(property, style.getPropertyValue(property));
      mirror.style.width = `${width}px`;
      mirror.value = value || " ";
      const contentHeight = mirror.scrollHeight + borderHeight;
      const height = Math.min(
        maximumHeight,
        Math.max(minimumHeight, contentHeight),
      );
      const contentBoxExtras =
        style.boxSizing === "border-box"
          ? 0
          : pixels("padding-top") + pixels("padding-bottom") + borderHeight;
      textarea.style.transition =
        animate && initialized && !motion?.matches ? heightTransition : "none";
      // Never reset the live editor to auto/zero to measure its content.
      textarea.style.height = `${Math.max(0, height - contentBoxExtras)}px`;
      textarea.style.overflowY =
        contentHeight > maximumHeight ? "auto" : "hidden";
      if (!value) {
        followLatest = true;
        retainedScrollTop = 0;
      }
      if (followLatest) follow();
      else textarea.scrollTop = retainedScrollTop;
      lastText = value;
      lastWidth = width;
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      frame = view.requestAnimationFrame(() => {
        initialized = true;
        textarea.style.transition = motion?.matches ? "none" : heightTransition;
        follow();
        frame = undefined;
      });
    };
    const resize = () => measure(latestText.current, false);
    const transitionEnd = (event: TransitionEvent) => {
      if (event.target === textarea && event.propertyName === "height")
        follow();
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(([entry]) => {
            if (
              !entry ||
              Math.abs(entry.contentRect.width - observedWidth) < 0.5
            )
              return;
            observedWidth = entry.contentRect.width;
            resize();
          });
    textarea.addEventListener("scroll", scroll, { passive: true });
    textarea.addEventListener("transitionend", transitionEnd);
    motion?.addEventListener("change", resize);
    if (observer) observer.observe(textarea);
    else view.addEventListener("resize", resize);
    measureRef.current = measure;
    measure(latestText.current, false);
    return () => {
      if (measureRef.current === measure) measureRef.current = undefined;
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      observer?.disconnect();
      view.removeEventListener("resize", resize);
      textarea.removeEventListener("scroll", scroll);
      textarea.removeEventListener("transitionend", transitionEnd);
      motion?.removeEventListener("change", resize);
      mirror.remove();
      Object.assign(textarea.style, previousStyle);
    };
  }, [active, textareaRef]);

  useLayoutEffect(() => {
    if (active) measureRef.current?.(text, true);
  }, [active, text, textareaRef]);
}
