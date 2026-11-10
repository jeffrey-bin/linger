import { describe, expect, it } from "vitest";
import {
  routineSchema,
  createRoutineInputSchema,
} from "./collaboration/tools/routines.js";

import {
  encodeAgentCommandBody,
  decodeAgentCommandResult,
} from "../business-routes.js";
import { toolSchemaToJsonSchema } from "../domain-support/schema.js";

describe("TeamHub Collaboration routines", () => {
  it("rejects schedules that mix fields or use a bad clock", () => {
    expect(
      createRoutineInputSchema.safeParse({
        name: "Morning",
        instruction: "Post it.",
        schedule: { kind: "daily", time: "9:00", timezone: "Asia/Shanghai" },
      }).success,
    ).toBe(false);
    expect(
      createRoutineInputSchema.safeParse({
        name: "Morning",
        instruction: "Post it.",
        schedule: { kind: "daily", time: "09:00", timezone: "Not/AZone" },
      }).success,
    ).toBe(false);
    expect(
      createRoutineInputSchema.safeParse({
        name: "Morning",
        instruction: "Post it.",
        schedule: {
          kind: "daily",
          time: "09:00",
          timezone: "Asia/Shanghai",
          weekday: "monday",
        },
      }).success,
    ).toBe(false);
    expect(
      createRoutineInputSchema.safeParse({
        name: "Morning",
        instruction: "Post it.",
        schedule: { kind: "every_n_hours", interval_hours: 4, timezone: "UTC" },
      }).success,
    ).toBe(false);
    expect(
      createRoutineInputSchema.safeParse({
        name: "Morning",
        instruction: "Post it.",
        schedule: { kind: "daily", time: "09:00", timezone: "Asia/Shanghai" },
        room_id: "room_1",
      }).success,
    ).toBe(false);
  });
  it("accepts one or multiple weekdays and rejects duplicate or legacy single-day selections", () => {
    const days = [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ];
    const cases: { selection: Record<string, unknown>; valid: boolean }[] = [
      { selection: {}, valid: false },
      { selection: { weekdays: [] }, valid: false },
      { selection: { weekdays: days }, valid: true },
      { selection: { weekdays: ["monday", "friday"] }, valid: true },
      { selection: { weekdays: ["funday"] }, valid: false },
      { selection: { weekday: "monday" }, valid: false },
    ];
    for (const weekday of days) {
      cases.push(
        { selection: { weekdays: [weekday] }, valid: true },
        { selection: { weekdays: [weekday, weekday] }, valid: false },
      );
    }
    for (const { selection, valid } of cases) {
      const input = {
        name: "Weekly",
        instruction: "Post it.",
        schedule: {
          kind: "weekly",
          time: "21:00",
          timezone: "Asia/Shanghai",
          ...selection,
        },
      };
      expect(
        createRoutineInputSchema.safeParse(input).success,
        JSON.stringify(selection),
      ).toBe(valid);
    }
    const schema = toolSchemaToJsonSchema(
      createRoutineInputSchema,
      "input",
    ) as {
      properties: {
        schedule: {
          oneOf: Array<{
            required: string[];
            properties: {
              kind: { const: string };
              weekdays: { uniqueItems: boolean };
            };
          }>;
        };
      };
    };
    const weekly = schema.properties.schedule.oneOf.find(
      (item) => item.properties.kind.const === "weekly",
    );
    expect(weekly!.properties.weekdays.uniqueItems).toBe(true);
    expect(weekly!.required).toEqual(
      expect.arrayContaining(["weekdays", "time", "timezone"]),
    );
    expect(weekly!.properties).not.toHaveProperty("weekday");
  });
  it("preserves a multi-day schedule through direct CLI request and response", async () => {
    const input = {
      name: "Weekdays",
      instruction: "Time to leave.",
      schedule: {
        kind: "weekly",
        weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
        time: "21:00",
        timezone: "Asia/Shanghai",
      },
    };
    expect(await encodeAgentCommandBody("create_routine", input)).toEqual(
      input,
    );
    const result = {
      ...input,
      id: "routine_1",
      enabled: true,
      next_run_at: "2026-10-09T13:00:00Z",
    };
    expect(await decodeAgentCommandResult("create_routine", result)).toEqual(
      result,
    );
    expect(routineSchema.safeParse(result).success).toBe(true);
  });
});
