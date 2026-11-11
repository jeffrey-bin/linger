import { z } from "zod";

import type { SetupCommand } from "../shared/setup.js";

// A provider key, or "" to remove the saved one; the installer checks the
// same shape before saving.
const providerKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._~+/=:-]{0,512}$/, "Invalid key");

const setupCommand = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("server.set"), serverUrl: z.string().max(2048) })
    .strict(),
  z
    .object({
      op: z.literal("local.start"),
      runtime: z
        .enum(["recommended", "codex", "claude", "pi", "local"])
        .optional(),
      keys: z
        .object({
          composio: providerKey.optional(),
          soniox: providerKey.optional(),
          xai: providerKey.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ op: z.literal("local.location.pick") }).strict(),
  z.object({ op: z.literal("local.location.reset") }).strict(),
  z
    .object({
      op: z.literal("local.signin.start"),
      code: z.string().trim().min(1).max(4096).optional(),
    })
    .strict(),
  z.object({ op: z.literal("local.signin.open") }).strict(),
  z.object({ op: z.literal("local.signin.cancel") }).strict(),
  z
    .object({
      op: z.literal("local.signin.switch"),
      runtime: z.enum(["codex", "claude", "pi"]),
    })
    .strict(),
  z.object({ op: z.literal("local.account.show"), on: z.boolean() }).strict(),
  z.object({ op: z.literal("local.account.copy") }).strict(),
  z.object({ op: z.literal("local.account.reveal") }).strict(),
  z.object({ op: z.literal("signin.open") }).strict(),
  z.object({ op: z.literal("computer.connect") }).strict(),
  z.object({ op: z.literal("notifications.test") }).strict(),
  z.object({ op: z.literal("prevent-sleep.set"), on: z.boolean() }).strict(),
  z.object({ op: z.literal("open-at-login.set"), on: z.boolean() }).strict(),
  z.object({ op: z.literal("folder.add") }).strict(),
  z
    .object({
      op: z.literal("permission.request"),
      id: z.enum(["folders", "automation"]),
    })
    .strict(),
  z
    .object({
      op: z.literal("permission.settings"),
      id: z.enum(["full-disk", "folders", "automation"]),
    })
    .strict(),
  z.object({ op: z.literal("finish") }).strict(),
  z.object({ op: z.literal("logs.open") }).strict(),
  z.object({ op: z.literal("diagnostics.save") }).strict(),
]);

// Commands come from a local page, but are still validated at the boundary.
export const parseSetupCommand = (value: unknown): SetupCommand =>
  setupCommand.parse(value) as SetupCommand;
