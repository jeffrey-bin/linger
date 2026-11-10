import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * In the desktop app a column's title sits in the grey bar on the window
 * frame above its card. The bar provides the element; titles rendered through
 * DesktopBarTitle move into it and stay in place where no bar is provided.
 */
export const DesktopBarSlot = createContext<HTMLElement | null>(null);

export function DesktopBarTitle({ children }: { children: ReactNode }) {
  const slot = useContext(DesktopBarSlot);
  return slot ? createPortal(children, slot) : children;
}
