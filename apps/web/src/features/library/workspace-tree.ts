import { createContext, useContext } from "react";

/** The Library sidebar the page headers open at phone width. */
export const WORKSPACE_TREE_ID = "workspace-tree";

export const WorkspaceTreeContext = createContext<{
  open: boolean;
  setOpen: (open: boolean, pathname?: string) => void;
}>({ open: false, setOpen: () => undefined });

export function useWorkspaceTree() {
  return useContext(WorkspaceTreeContext);
}
