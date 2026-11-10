/** Private runtime state and installed dependencies never belong in published folders. */
export const isExcludedPublicationEntry = (name: string): boolean => {
  const entry = process.platform === "win32" ? name.toLowerCase() : name;
  return (
    [".teamhub", ".agents", ".git", "node_modules"].includes(entry) ||
    entry === ".env" ||
    entry.startsWith(".env.")
  );
};
