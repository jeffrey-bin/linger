import type { CommandDefinition } from "./command-definition.js";
import {
  assertPositionals,
  bodySource,
  option,
  values,
} from "./command-input.js";
import {
  booleanSchema,
  email,
  number,
  pageInput,
  pageSchema,
  schema,
  stringSchema,
  text,
  usage,
} from "./connector-input.js";
import {
  connectorDefinition,
  cursor,
  nextCursor,
  optionalFields,
  record,
  requiredString,
  toggle,
  value,
  type ConnectorRuntime,
  type Json,
} from "./connector-runtime.js";
import { ConnectorError as CliError } from "./errors.js";
import {
  array,
  calendarWriteSchema,
  eventSchema,
  id,
  object,
  pageOutput,
  rootSchema,
  str,
} from "./connector-schemas.js";
import { displayText } from "./display-text.js";

const pageOptions = {
  "--limit": value("1–100 items per page; default 20."),
  "--cursor": value(
    "Cursor from the previous page; keep the same account and filters.",
  ),
};
const calendarOption = { "--calendar": value("Calendar ID; default primary.") };
const bodyOptions = {
  "--content": value("Event description; exclusive with --file."),
  "--file": value("UTF-8 description file; - reads stdin."),
};
const options = {
  calendars: pageOptions,
  list: {
    ...calendarOption,
    ...pageOptions,
    "--date": value("today / tomorrow / YYYY-MM-DD; default today."),
    "--from": value("RFC3339 start time; use together with --to."),
    "--to": value("RFC3339 end time, exclusive of this instant."),
    "--timezone": value(
      "IANA time zone for date mode; default calendar time zone.",
    ),
    "--query": value("Event keyword; at most 1000 characters."),
  },
  read: calendarOption,
  free: {
    "--from": value("RFC3339 start of the time window."),
    "--to": value("RFC3339 end of the time window; at most 31 days."),
    "--with": value(
      "Email of the other person's primary calendar; repeatable.",
      true,
    ),
    "--calendar": value(
      "Calendar ID; repeatable; includes primary when omitted.",
      true,
    ),
    "--duration": value(
      "Minimum consecutive free minutes, 1–1440; default 30.",
    ),
  },
  create: {
    ...calendarOption,
    ...bodyOptions,
    "--start": value("RFC3339 start time."),
    "--end": value("RFC3339 end time; exclusive with --duration."),
    "--duration": value("Duration in minutes, 1–1440; default 30."),
    "--attendee": value("Attendee email; repeatable; at most 50.", true),
    "--location": value("Location; at most 1000 characters."),
    "--meet": toggle("Request a Google Meet link."),
  },
  update: {
    ...calendarOption,
    ...bodyOptions,
    "--title": value("New title; at most 500 characters."),
    "--start": value("New start time; must be used with --end."),
    "--end": value("New end time; must be used with --start."),
    "--add-attendee": value("Add one email; repeatable.", true),
    "--remove-attendee": value(
      "Remove one email; repeatable; cannot remove the organizer.",
      true,
    ),
    "--location": value("New location."),
  },
  cancel: calendarOption,
};
type Action = keyof typeof options;
const descriptions: Record<Action, string> = {
  calendars: "List available calendars.",
  list: "List events for a day or a time window.",
  read: "Read event details and attendees.",
  free: "Find shared free time across calendars; query only, does not book.",
  create: "Create a meeting and notify attendees.",
  update: "Update a single meeting and notify attendees.",
  cancel: "Cancel a meeting as the organizer and notify attendees.",
};
export const calendarCommandDefinitions: CommandDefinition[] = (
  Object.keys(options) as Action[]
).map((action) =>
  connectorDefinition({
    command: ["gcal", action],
    description: descriptions[action],
    readOnly: ["calendars", "list", "read", "free"].includes(action),
    options: options[action],
    usage:
      action === "free"
        ? [
            "teamhub gcal free --from <RFC3339> --to <RFC3339> [--with <email>] [--calendar <id>] [flags]",
          ]
        : action === "create"
          ? [
              "teamhub gcal create <title> --start <RFC3339> [--end <RFC3339> | --duration <minutes>] [flags]",
            ]
          : [
              `teamhub gcal ${action}${["read", "update", "cancel"].includes(action) ? " <event-id>" : ""} [flags]`,
            ],
    examples:
      action === "calendars"
        ? ["teamhub gcal calendars"]
        : action === "list"
          ? ["teamhub gcal list --date tomorrow --timezone America/New_York"]
          : action === "free"
            ? [
                "teamhub gcal free --from 2026-10-19T09:00:00-04:00 --to 2026-10-19T18:00:00-04:00 --with alice@example.invalid",
              ]
            : action === "create"
              ? [
                  "teamhub gcal create 'Project sync' --start 2026-10-19T10:00:00-04:00 --duration 30 --attendee alice@example.invalid --meet",
                ]
              : action === "update"
                ? [
                    "teamhub gcal update event_example --title 'Project sync (rescheduled)' --add-attendee bob@example.invalid",
                  ]
                : action === "read"
                  ? ["teamhub gcal read event_example"]
                  : ["teamhub gcal cancel event_example"],
    inputSchema: calendarSchema(action),
    outputSchema:
      action === "calendars"
        ? rootSchema(
            {
              calendars: array(
                object(
                  {
                    calendarId: id,
                    name: str,
                    timeZone: str,
                    accessRole: str,
                    primary: { type: "boolean" },
                  },
                  ["calendarId"],
                ),
              ),
              ...pageOutput,
            },
            ["calendars", "hasMore"],
          )
        : action === "list"
          ? rootSchema({ events: array(eventSchema), ...pageOutput }, [
              "events",
              "hasMore",
            ])
          : action === "read"
            ? rootSchema({ event: eventSchema })
            : action === "free"
              ? rootSchema({
                  calendarIds: array(id),
                  window: object({
                    from: { type: "string", format: "date-time" },
                    to: { type: "string", format: "date-time" },
                  }),
                  durationMinutes: { type: "integer" },
                  slots: array(
                    object({
                      start: { type: "string", format: "date-time" },
                      end: { type: "string", format: "date-time" },
                      durationMinutes: { type: "integer" },
                    }),
                  ),
                })
              : rootSchema({ result: calendarWriteSchema }),
    normalize: async (args, reader) => {
      const input: Json = {};
      assertPositionals(
        args,
        ["read", "update", "cancel", "create"].includes(action) ? 1 : 0,
      );
      if (["read", "update", "cancel"].includes(action))
        input.eventId = text(args.positionals[0], "event ID", 1024);
      if (action !== "calendars" && action !== "free")
        input.calendarId =
          option(args, "--calendar") === undefined
            ? "primary"
            : text(option(args, "--calendar"), "--calendar", 1024);
      if (["calendars", "list"].includes(action))
        Object.assign(input, pageInput(args));
      if (action === "list") {
        const from = option(args, "--from"),
          to = option(args, "--to"),
          date = option(args, "--date"),
          zone = option(args, "--timezone");
        if ((from === undefined) !== (to === undefined))
          usage("Provide --from and --to together.");
        if (from !== undefined) {
          if (date !== undefined || zone !== undefined)
            usage(
              "A time window cannot be combined with --date or --timezone.",
            );
          Object.assign(input, timeWindow(from, to!, 366));
        } else {
          input.date = date ?? "today";
          if (
            !["today", "tomorrow"].includes(String(input.date)) &&
            !validDate(String(input.date))
          )
            usage(
              "--date requires today, tomorrow, or a valid YYYY-MM-DD date.",
            );
          if (zone !== undefined) {
            validateTimeZone(zone);
            input.timeZone = zone;
          }
        }
        if (option(args, "--query") !== undefined)
          input.query = text(option(args, "--query"), "--query", 1000);
      }
      if (action === "free") {
        Object.assign(
          input,
          timeWindow(option(args, "--from"), option(args, "--to"), 31),
        );
        input.durationMinutes = number(
          option(args, "--duration"),
          "--duration",
          1,
          1440,
          30,
        );
        if (
          Number(input.durationMinutes) * 60000 >
          Date.parse(String(input.to)) - Date.parse(String(input.from))
        )
          usage("--duration exceeds the query window.");
        const explicit = values(args, "--calendar").map((x) =>
          text(x, "--calendar", 1024),
        );
        input.calendarIds = [
          ...new Set([
            ...(explicit.length ? explicit : ["primary"]),
            ...values(args, "--with").map(email),
          ]),
        ];
        if ((input.calendarIds as string[]).length > 20)
          usage("At most 20 calendars may be queried.");
      }
      if (action === "create" || action === "update") {
        const title =
          action === "create" ? args.positionals[0] : option(args, "--title");
        if (title !== undefined) input.title = text(title, "title", 500);
        const location = option(args, "--location");
        if (location !== undefined)
          input.location = text(location, "--location", 1000);
        const content = await bodySource(args, reader, false);
        if (content !== undefined) {
          if (Buffer.byteLength(content) > 1 << 20)
            usage("The description exceeds 1 MiB.");
          input.description = content;
        }
        const start = option(args, "--start"),
          end = option(args, "--end"),
          duration = option(args, "--duration");
        if (action === "create") {
          input.start = rfc3339(start, "--start");
          if (end !== undefined && duration !== undefined)
            usage("Choose --end or --duration.");
          input.end =
            end === undefined
              ? new Date(
                  Date.parse(String(input.start)) +
                    number(duration, "--duration", 1, 1440, 30)! * 60000,
                ).toISOString()
              : rfc3339(end, "--end");
          if (option(args, "--meet")) input.meet = true;
        } else if (start !== undefined || end !== undefined) {
          if (start === undefined || end === undefined)
            usage("Provide --start and --end together.");
          input.start = rfc3339(start, "--start");
          input.end = rfc3339(end, "--end");
        }
        if (
          input.start !== undefined &&
          Date.parse(String(input.end)) <= Date.parse(displayText(input.start))
        )
          usage("--end must be later than --start.");
        for (const [flag, key] of action === "create"
          ? [["--attendee", "attendees"]]
          : [
              ["--add-attendee", "addAttendees"],
              ["--remove-attendee", "removeAttendees"],
            ]) {
          const list = [...new Set(values(args, flag!).map(email))];
          if (list.length > 50) usage("At most 50 attendees are allowed.");
          if (list.length) input[key!] = list;
        }
        if (
          (input.addAttendees as string[] | undefined)?.some((x) =>
            (input.removeAttendees as string[] | undefined)?.includes(x),
          )
        )
          usage("The same attendee cannot be added and removed.");
        if (
          action === "update" &&
          ![
            "title",
            "location",
            "description",
            "start",
            "addAttendees",
            "removeAttendees",
          ].some((x) => input[x] !== undefined)
        )
          usage("Provide at least one event change.");
      }
      return { input };
    },
    bindings: (input) =>
      action === "calendars"
        ? ["GOOGLECALENDAR_LIST_CALENDARS"]
        : action === "list"
          ? [
              "GOOGLECALENDAR_EVENTS_LIST",
              ...(input.date !== undefined
                ? ["GOOGLECALENDAR_GET_CALENDAR"]
                : []),
            ]
          : action === "free"
            ? ["GOOGLECALENDAR_FREE_BUSY_QUERY"]
            : action === "read"
              ? ["GOOGLECALENDAR_EVENTS_GET"]
              : action === "create"
                ? ["GOOGLECALENDAR_CREATE_EVENT"]
                : [
                    "GOOGLECALENDAR_EVENTS_GET",
                    action === "cancel"
                      ? "GOOGLECALENDAR_DELETE_EVENT"
                      : input.addAttendees || input.removeAttendees
                        ? "GOOGLECALENDAR_BATCH_EVENTS"
                        : "GOOGLECALENDAR_PATCH_EVENT",
                  ],
    execute: async (input, runtime) => {
      const result = await executeCalendar(action, input, runtime);
      return ["create", "update", "cancel"].includes(action)
        ? { result }
        : result;
    },
  }),
);

function calendarSchema(action: Action): Json {
  const time = { type: "string", format: "date-time" };
  const list = {
    type: "array",
    items: { type: "string", format: "email" },
    maxItems: 50,
  };
  return schema(
    action === "calendars"
      ? pageSchema
      : action === "free"
        ? {
            from: time,
            to: time,
            calendarIds: {
              type: "array",
              items: stringSchema,
              minItems: 1,
              maxItems: 20,
            },
            durationMinutes: {
              type: "integer",
              minimum: 1,
              maximum: 1440,
              default: 30,
            },
          }
        : {
            calendarId: { ...stringSchema, default: "primary" },
            ...(action === "list"
              ? {
                  ...pageSchema,
                  date: stringSchema,
                  timeZone: stringSchema,
                  from: time,
                  to: time,
                  query: stringSchema,
                }
              : action === "read" || action === "cancel"
                ? { eventId: stringSchema }
                : {
                    eventId: stringSchema,
                    title: stringSchema,
                    start: time,
                    end: time,
                    description: { type: "string" },
                    location: stringSchema,
                    attendees: list,
                    addAttendees: list,
                    removeAttendees: list,
                    meet: booleanSchema,
                  }),
          },
  );
}
export function rfc3339(v: unknown, label: string): string {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      v,
    ) ||
    !Number.isFinite(Date.parse(v)) ||
    !validDate(v.slice(0, 10)) ||
    Number(v.slice(11, 13)) > 23 ||
    Number(v.slice(14, 16)) > 59 ||
    Number(v.slice(17, 19)) > 59
  )
    usage(
      `${label} requires a valid RFC3339 time with Z or an explicit offset.`,
    );
  return v as string;
}
/**
 * Common free time of every requested calendar. A missing calendar, a
 * calendar error, or an absent busy list means availability is unknown,
 * never that the calendar is free.
 */
export function commonFreeSlots(
  raw: Json,
  ids: readonly string[],
  from: string,
  to: string,
  minutes: number,
): Json[] {
  const unknown = (): never => {
    throw new CliError(
      "incomplete_response",
      "A requested calendar is missing, inaccessible, or incomplete; availability is unknown.",
    );
  };
  const map = (v: unknown): Json =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : unknown();
  const instant = (v: unknown): number =>
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      v,
    ) &&
    Number.isFinite(Date.parse(v))
      ? Date.parse(v)
      : unknown();
  const calendars = map(raw.calendars);
  const groups = raw.groups;
  // Group expansion is never requested, so its presence is unexpected.
  if (groups && typeof groups === "object" && Object.keys(groups).length)
    unknown();
  const start = Date.parse(from),
    end = Date.parse(to);
  const busy: [number, number][] = [];
  for (const id of ids) {
    const calendar = map(calendars[id]);
    const errors = calendar.errors;
    if (
      errors !== undefined &&
      errors !== null &&
      (!Array.isArray(errors) || errors.length)
    )
      unknown();
    if (!Array.isArray(calendar.busy)) unknown();
    for (const value of calendar.busy as unknown[]) {
      const interval = map(value);
      const a = instant(interval.start),
        b = instant(interval.end);
      if (b <= a) unknown();
      if (Math.min(b, end) > Math.max(a, start))
        busy.push([Math.max(a, start), Math.min(b, end)]);
    }
  }
  busy.sort((x, y) => x[0] - y[0]);
  const slots: Json[] = [];
  const add = (a: number, b: number) => {
    if (b - a >= minutes * 60000)
      slots.push({
        start: utc(a),
        end: utc(b),
        durationMinutes: Math.floor((b - a) / 60000),
      });
  };
  let position = start;
  for (const [a, b] of busy) {
    if (a > position) add(position, a);
    position = Math.max(position, b);
  }
  add(position, end);
  return slots;
}
const utc = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
function validDate(v: string): boolean {
  const date = new Date(v + "T00:00:00Z");
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(v) &&
    Number.isFinite(date.valueOf()) &&
    date.toISOString().slice(0, 10) === v
  );
}
function timeWindow(from: unknown, to: unknown, days: number): Json {
  const start = rfc3339(from, "--from"),
    end = rfc3339(to, "--to");
  const duration = Date.parse(end) - Date.parse(start);
  if (duration <= 0 || duration > days * 86400000)
    usage(`The time window must be positive and no longer than ${days} days.`);
  return { from: start, to: end };
}
function validateTimeZone(zone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
  } catch {
    usage("--timezone requires a valid IANA time zone.");
  }
}
function dateInZone(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
function midnight(date: string, zone: string): string {
  const target = Date.parse(date + "T00:00:00Z");
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 5; i++) {
    const p = Object.fromEntries(
      formatter.formatToParts(guess).map((x) => [x.type, x.value]),
    );
    const wall = Date.parse(
      `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
    );
    if (wall === target) return new Date(guess).toISOString();
    guess += target - wall;
  }
  throw new CliError(
    "unsupported_combination",
    "This local date has no representable midnight; use an explicit time window.",
  );
}
async function executeCalendar(
  action: Action,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const calendarId = displayText(input.calendarId ?? "primary");
  if (action === "free") {
    const ids = input.calendarIds as string[];
    const raw = await runtime.call("GOOGLECALENDAR_FREE_BUSY_QUERY", {
      timeMin: input.from,
      timeMax: input.to,
      items: ids.map((id) => ({ id })),
      calendarExpansionMax: ids.length,
    });
    return {
      calendarIds: ids,
      window: { from: input.from, to: input.to },
      durationMinutes: input.durationMinutes,
      slots: commonFreeSlots(
        raw,
        ids,
        displayText(input.from),
        displayText(input.to),
        Number(input.durationMinutes),
      ),
    };
  }
  if (action === "calendars" || action === "list") {
    const fingerprint = {
      account: runtime.account.connection_id,
      action,
      calendarId,
      limit: input.limit,
      query: input.query ?? "",
      date: input.date ?? "",
      timeZone: input.timeZone ?? "",
      from: input.from ?? "",
      to: input.to ?? "",
    };
    const state = cursor(input.cursor, fingerprint);
    let from = input.from ?? state.from,
      to = input.to ?? state.to;
    if (action === "list" && input.date && from === undefined) {
      const cal = await runtime.call("GOOGLECALENDAR_GET_CALENDAR", {
        calendar_id: calendarId,
      });
      const zone =
        input.timeZone === undefined
          ? requiredString(cal.timeZone, "calendar time zone")
          : displayText(input.timeZone);
      validateTimeZone(zone);
      let date = ["today", "tomorrow"].includes(displayText(input.date))
        ? dateInZone(new Date(), zone)
        : displayText(input.date);
      if (input.date === "tomorrow")
        date = new Date(Date.parse(date + "T12:00:00Z") + 86400000)
          .toISOString()
          .slice(0, 10);
      const next = new Date(Date.parse(date + "T12:00:00Z") + 86400000)
        .toISOString()
        .slice(0, 10);
      from = midnight(date, zone);
      to = midnight(next, zone);
    }
    const raw = await runtime.call(
      action === "calendars"
        ? "GOOGLECALENDAR_LIST_CALENDARS"
        : "GOOGLECALENDAR_EVENTS_LIST",
      action === "calendars"
        ? optionalFields({
            max_results: input.limit,
            page_token: state.token,
            show_deleted: false,
          })
        : optionalFields({
            calendarId,
            maxResults: input.limit,
            pageToken: state.token,
            timeMin: from,
            timeMax: to,
            query: input.query,
            singleEvents: true,
            orderBy: "startTime",
            showDeleted: false,
          }),
    );
    const rows =
      raw.items ?? (action === "calendars" ? raw.calendars : raw.events);
    if (!Array.isArray(rows))
      throw new CliError(
        "incomplete_response",
        "The calendar page is incomplete.",
      );
    const token = raw.nextPageToken ?? raw.next_page_token;
    return {
      [action === "calendars" ? "calendars" : "events"]: rows.map((x) =>
        action === "calendars"
          ? decodeCalendar(record(x))
          : decodeEvent(record(x), calendarId),
      ),
      hasMore: Boolean(token),
      ...(token
        ? {
            nextCursor: nextCursor(
              optionalFields({ token, from, to }),
              fingerprint,
            ),
          }
        : {}),
    };
  }
  if (action === "read")
    return {
      event: decodeEvent(
        await runtime.call("GOOGLECALENDAR_EVENTS_GET", {
          calendar_id: calendarId,
          event_id: input.eventId,
        }),
        calendarId,
      ),
    };
  if (action === "create") {
    const raw = await runtime.call(
      "GOOGLECALENDAR_CREATE_EVENT",
      optionalFields({
        calendar_id: calendarId,
        summary: input.title,
        start_datetime: input.start,
        end_datetime: input.end,
        attendees: input.attendees ?? [],
        description: input.description,
        location: input.location,
        create_meeting_room: input.meet === true,
        send_updates: "all",
        exclude_organizer: false,
      }),
      true,
    );
    const event = decodeEvent(raw, calendarId);
    if (input.meet && !event.meetingUrl)
      throw new CliError(
        "outcome_unknown",
        "The event exists, but its requested Meet link was not confirmed.",
        { event_id: event.eventId },
      );
    return { action: "created", acknowledged: true, event };
  }
  const current = await runtime.call("GOOGLECALENDAR_EVENTS_GET", {
    calendar_id: calendarId,
    event_id: input.eventId,
  });
  if (current.recurrence || current.recurringEventId)
    throw new CliError(
      "unsupported_combination",
      "Recurring event writes are pending; select a single nonrecurring event.",
      { operation_rejected: true },
    );
  const organizer = current.organizer ? record(current.organizer) : undefined;
  if (organizer?.self !== true)
    throw new CliError(
      "forbidden",
      "Only the event organizer can modify or cancel this meeting.",
      { operation_rejected: true },
    );
  if (action === "cancel") {
    await runtime.call(
      "GOOGLECALENDAR_DELETE_EVENT",
      { calendar_id: calendarId, event_id: input.eventId, send_updates: "all" },
      true,
    );
    return {
      action: "canceled",
      acknowledged: true,
      eventId: requiredString(current.id, "canceled event ID"),
    };
  }
  let raw: Json;
  if (input.addAttendees || input.removeAttendees) {
    if (
      current.attendeesOmitted === true ||
      (current.attendees !== undefined && !Array.isArray(current.attendees))
    )
      throw new CliError(
        "incomplete_response",
        "The full attendee list is unavailable.",
        { operation_rejected: true },
      );
    const remove = (input.removeAttendees ?? []) as string[],
      add = (input.addAttendees ?? []) as string[];
    const same = (a: unknown, b: string) =>
      String(a).toLowerCase() === b.toLowerCase();
    if (remove.some((x) => same(organizer?.email, x)))
      usage("The organizer cannot be removed.");
    const attendees = ((current.attendees ?? []) as unknown[]).map((x) =>
      record(x),
    );
    for (const entry of attendees)
      requiredString(entry.email, "existing attendee email");
    const merged = attendees.filter(
      (x) => !remove.some((a) => same(x.email, a)),
    );
    for (const address of add)
      if (!merged.some((x) => same(x.email, address)))
        merged.push({ email: address });
    if (merged.length > 50)
      usage("The resulting meeting exceeds 50 attendees.");
    const result = await runtime.call(
      "GOOGLECALENDAR_BATCH_EVENTS",
      {
        operations: [
          {
            op_id: "update",
            method: "PATCH",
            calendar_id: calendarId,
            event_id: input.eventId,
            query_params: { sendUpdates: "all" },
            body: optionalFields({
              summary: input.title,
              location: input.location,
              description: input.description,
              start: input.start ? { dateTime: input.start } : undefined,
              end: input.end ? { dateTime: input.end } : undefined,
              attendees: merged,
            }),
          },
        ],
        fail_fast: true,
      },
      true,
    );
    const results = result.results ?? result.responses;
    if (!Array.isArray(results) || results.length !== 1)
      throw new CliError(
        "outcome_unknown",
        "The attendee update has no complete per-operation result.",
      );
    const item = record(results[0]);
    if (
      item.op_id !== "update" ||
      typeof item.http_status !== "number" ||
      item.http_status < 200 ||
      item.http_status >= 300 ||
      item.error
    )
      throw new CliError(
        "outcome_unknown",
        "The attendee update was not confirmed.",
      );
    raw = record(item.event);
  } else
    raw = await runtime.call(
      "GOOGLECALENDAR_PATCH_EVENT",
      optionalFields({
        calendar_id: calendarId,
        event_id: input.eventId,
        summary: input.title,
        location: input.location,
        description: input.description,
        start_time: input.start,
        end_time: input.end,
        send_updates: "all",
      }),
      true,
    );
  return {
    action: "updated",
    acknowledged: true,
    event: decodeEvent(raw, calendarId),
  };
}
function decodeCalendar(raw: Json): Json {
  return optionalFields({
    calendarId: requiredString(raw.id, "calendar ID"),
    name: raw.summary,
    timeZone: raw.timeZone,
    accessRole: raw.accessRole,
    primary: raw.primary,
  });
}
function decodeEvent(raw: Json, calendarId: string): Json {
  const event =
    raw.event && typeof raw.event === "object" ? record(raw.event) : raw;
  const conference =
    event.conferenceData && typeof event.conferenceData === "object"
      ? record(event.conferenceData)
      : {};
  const meeting = Array.isArray(conference.entryPoints)
    ? conference.entryPoints
        .map((x) => record(x))
        .find((x) => x.entryPointType === "video")?.uri
    : undefined;
  return optionalFields({
    eventId: requiredString(event.id, "event ID"),
    calendarId,
    title: event.summary,
    description: event.description,
    location: event.location,
    status: event.status,
    start: event.start
      ? optionalFields({
          date: record(event.start).date,
          dateTime: record(event.start).dateTime,
          timeZone: record(event.start).timeZone,
        })
      : undefined,
    end: event.end
      ? optionalFields({
          date: record(event.end).date,
          dateTime: record(event.end).dateTime,
          timeZone: record(event.end).timeZone,
        })
      : undefined,
    organizerEmail: event.organizer ? record(event.organizer).email : undefined,
    url: event.htmlLink,
    meetingUrl: event.hangoutLink ?? meeting,
    recurringEventId: event.recurringEventId,
    attendees: Array.isArray(event.attendees)
      ? event.attendees.map((x) => {
          const a = record(x);
          return optionalFields({
            email: requiredString(a.email, "attendee email"),
            responseStatus: a.responseStatus,
          });
        })
      : undefined,
  });
}
