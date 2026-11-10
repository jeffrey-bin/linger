export const roomE2ESpecs = [
  "room-routines.spec.ts",
  "room-startup-production.spec.ts",
  "room-startup.spec.ts",
  "room-creation.spec.ts",
] as const;

export const roomDocumentE2ESpecs = [
  "room-document-office-preview-entry.spec.ts",
  "room-document-assets.spec.ts",
  "room-document-collaboration.spec.ts",
  "room-document-comments.spec.ts",
  "room-document-frontmatter.spec.ts",
] as const;

// Every Playwright spec runs against one isolated TeamHub/Document Runtime stack.
export const realServiceE2ESpecs = [
  "room-login-chain.spec.ts",
  ...roomE2ESpecs,
  ...roomDocumentE2ESpecs,
] as const;

// Local per-file test seconds (CI-equivalent prebuilt run); greedy 3-way pack ≈55 / 70 / 62s. CI scales roughly evenly.
export const roomDocumentE2EShards = [
  [
    "room-document-collaboration.spec.ts", // 38
    "room-document-frontmatter.spec.ts", // 17
    "room-startup-production.spec.ts", // ~0
  ],
  [
    "room-document-comments.spec.ts", // 33
    "room-login-chain.spec.ts", // 27
    "room-document-office-preview-entry.spec.ts", // 10
  ],
  [
    "room-document-assets.spec.ts", // 22
    "room-creation.spec.ts", // 17
    "room-startup.spec.ts", // 15
    "room-routines.spec.ts", // 8
  ],
] as const;
