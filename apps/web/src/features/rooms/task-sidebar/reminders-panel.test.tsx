import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubRoutine } from "@/features/teamhub/teamhub-types";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type {
  TestRouteHandler,
  TestRouteRequest,
} from "@/test/teamhub-test-server";

import { RemindersPanel } from "./reminders-panel";

const AGENT = "agent-1";

function inDays(days: number, hour = 10) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

const reminder: TeamHubRoutine = {
  id: "routine_1",
  room_id: "room-1",
  created_by_actor_id: AGENT,
  name: "Daily brief",
  instruction: "Write the daily brief",
  cadence: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
  enabled: true,
  revision: 1,
  created_at: "2026-09-21T00:00:00Z",
  updated_at: "2026-09-21T00:00:00Z",
  next_run_at: inDays(1, 9),
};

/** The TeamHub Routine routes one test answers, by the call they serve. */
interface RoutineRoutes {
  createRoomRoutine?: TestRouteHandler;
  deleteRoutine?: TestRouteHandler;
  listRoomRoutines: TestRouteHandler;
  updateRoutine?: TestRouteHandler;
}

function renderPanel(routes: RoutineRoutes, agentScoped = true) {
  const runtime = createTestTeamHubRuntime();
  runtime.server.on(
    "GET",
    "/v0/rooms/{roomId}/routines",
    routes.listRoomRoutines,
  );
  if (routes.createRoomRoutine)
    runtime.server.on(
      "POST",
      "/v0/rooms/{roomId}/routines",
      routes.createRoomRoutine,
    );
  if (routes.updateRoutine)
    runtime.server.on(
      "PATCH",
      "/v0/routines/{routineId}",
      routes.updateRoutine,
    );
  if (routes.deleteRoutine)
    runtime.server.on(
      "DELETE",
      "/v0/routines/{routineId}",
      routes.deleteRoutine,
    );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RemindersPanel
          agentActorId={agentScoped ? AGENT : undefined}
          mentionOptions={[]}
          roomId="room-1"
          tenantId="tenant-1"
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

const list = (items: TeamHubRoutine[]) =>
  vi.fn<TestRouteHandler>(() => ({ items, page: { has_more: false } }));

/** The Routine ID and expected revision each delete request carried. */
function deletedRoutines(handler: ReturnType<typeof vi.fn<TestRouteHandler>>) {
  return handler.mock.calls.map(([request]: [TestRouteRequest]) => [
    request.params.routineId,
    Number(request.query.get("expected_revision")),
  ]);
}

/** The JSON body of one recorded route request. */
function sentBody(
  handler: ReturnType<typeof vi.fn<TestRouteHandler>>,
  call: number,
) {
  return handler.mock.calls[call]?.[0].body;
}

async function chooseWhen(dialog: HTMLElement, label: string) {
  fireEvent.click(within(dialog).getByRole("combobox", { name: "When" }));
  fireEvent.click(await within(dialog).findByRole("option", { name: label }));
}

async function openRoutine(name: string | RegExp) {
  fireEvent.click(await screen.findByRole("button", { name }));
  return screen.getByRole("dialog", { name: "Edit routine" });
}

describe("RemindersPanel", () => {
  it("names each routine and says when it only posts a message", async () => {
    renderPanel({ listRoomRoutines: list([reminder]) });
    expect(
      await screen.findByRole("button", { name: /^Daily brief/ }),
    ).toBeVisible();
    expect(screen.getByText(/Message only$/)).toBeVisible();
    // The long instruction stays in the dialog, and deleting happens there.
    expect(screen.queryByText("Write the daily brief")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete routine" })).toBeNull();
  });
  it("shows the empty state when the Room has no routines", async () => {
    renderPanel({ listRoomRoutines: list([]) });
    expect(
      await screen.findByText("No routines in this room yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New routine" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Paused" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Done/ })).toBeNull();
  });

  it("lays one-time reminders out by day and keeps recurring, paused and done apart", async () => {
    const once = (days: number) => ({
      kind: "once" as const,
      timezone: "UTC",
      run_at: inDays(days),
    });
    renderPanel({
      listRoomRoutines: list([
        {
          ...reminder,
          id: "r1",
          name: "Pay the bill",
          instruction: "Pay the bill",
          cadence: once(4),
          next_run_at: inDays(4),
        },
        {
          ...reminder,
          id: "r2",
          name: "Vote",
          instruction: "Vote",
          cadence: once(1),
          next_run_at: inDays(1),
        },
        {
          ...reminder,
          id: "r3",
          name: "Inbox sweep",
          instruction: "Inbox sweep",
          cadence: {
            kind: "weekly",
            timezone: "UTC",
            hour: 0,
            minute: 0,
            weekdays: ["monday"],
          },
          next_run_at: undefined,
        },
        {
          ...reminder,
          id: "r4",
          name: "On hold",
          instruction: "On hold",
          enabled: false,
        },
        {
          ...reminder,
          id: "r5",
          name: "Old check",
          instruction: "Old check",
          enabled: false,
          next_run_at: undefined,
          cadence: once(-3),
        },
      ]),
    });
    const upcoming = await screen.findByRole("region", { name: "Upcoming" });
    const vote = within(upcoming).getByText("Vote");
    const bill = within(upcoming).getByText("Pay the bill");
    expect(within(upcoming).getByText(/^Tomorrow · /)).toBeVisible();
    expect(within(upcoming).getByText(/ · in 4 days/)).toBeVisible();
    expect(within(upcoming).queryByText(/Once/)).not.toBeInTheDocument();
    // The sooner run comes first.
    expect(
      vote.compareDocumentPosition(bill) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // A repeating Routine is recurring, whether or not it has a next run yet.
    const recurring = screen.getByRole("region", { name: "Recurring" });
    expect(within(recurring).getByText("Inbox sweep")).toBeVisible();
    expect(within(recurring).getByText(/^Monday · /)).toBeVisible();
    expect(within(upcoming).queryByText("Inbox sweep")).toBeNull();
    const paused = screen.getByRole("region", { name: "Paused" });
    expect(
      within(paused).getByRole("switch", { name: "Enable routine" }),
    ).not.toBeChecked();
    // Done one-shot Routines stay folded away until asked for.
    expect(screen.queryByText("Old check")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Done/ }));
    expect(screen.getByText("Old check")).toBeVisible();
  });

  it("opens a routine in a dialog to edit, run or delete it", async () => {
    const deleteRoutine = vi.fn<TestRouteHandler>();
    renderPanel({ listRoomRoutines: list([reminder]), deleteRoutine });
    const dialog = await openRoutine(/Daily brief/);
    expect(within(dialog).queryByLabelText("Name (optional)")).toBeNull();
    expect(
      within(dialog).queryByRole("combobox", { name: "Mention" }),
    ).toBeNull();
    expect(within(dialog).getByLabelText("Instruction")).toHaveValue(
      "Write the daily brief",
    );
    expect(
      within(dialog).getByRole("button", { name: "Run now" }),
    ).toBeVisible();
    expect(
      within(dialog).queryByRole("combobox", { name: "Mention" }),
    ).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deletedRoutines(deleteRoutine)).toContainEqual(["routine_1", 1]),
    );
  });

  it("can rename a routine and remove its Agent target", async () => {
    const updateRoutine = vi.fn<TestRouteHandler>(() => reminder);
    renderPanel(
      {
        listRoomRoutines: list([{ ...reminder, mention_actor_id: AGENT }]),
        updateRoutine,
      },
      false,
    );
    const dialog = await openRoutine(/Daily brief/);
    fireEvent.change(within(dialog).getByLabelText("Name (optional)"), {
      target: { value: "Morning update" },
    });
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Mention" }));
    fireEvent.click(await screen.findByRole("option", { name: "None" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateRoutine).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            name: "Morning update",
            mention_actor_id: null,
          }),
          params: { routineId: reminder.id },
        }),
      ),
    );
  });

  it("preserves the name and target when editing an Agent's routine", async () => {
    const updateRoutine = vi.fn<TestRouteHandler>(() => reminder);
    renderPanel({
      listRoomRoutines: list([{ ...reminder, mention_actor_id: AGENT }]),
      updateRoutine,
    });
    const dialog = await openRoutine(/Daily brief/);
    fireEvent.change(within(dialog).getByLabelText("Instruction"), {
      target: { value: "Write the updated brief" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateRoutine).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            name: "Daily brief",
            mention_actor_id: AGENT,
            instruction: "Write the updated brief",
          }),
          params: { routineId: reminder.id },
        }),
      ),
    );
  });

  it("creates a weekday routine, named after its instruction and waking the Agent", async () => {
    const createRoomRoutine = vi.fn<TestRouteHandler>(() => reminder);
    renderPanel({ listRoomRoutines: list([]), createRoomRoutine });
    fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
    const dialog = screen.getByRole("dialog", { name: "New routine" });
    fireEvent.change(within(dialog).getByLabelText("Instruction"), {
      target: { value: "Remind me to leave work.\nBring the laptop." },
    });
    await chooseWhen(dialog, "Weekdays");
    expect(
      within(dialog).getByRole("checkbox", { name: "Friday" }),
    ).toBeChecked();
    expect(
      within(dialog).getByRole("button", { name: "9 AM" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText("Mon–Fri · 9:00 AM")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createRoomRoutine).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(sentBody(createRoomRoutine, 0)).toMatchObject({
      name: "Remind me to leave work.",
      mention_actor_id: AGENT,
      cadence: {
        kind: "weekly",
        hour: 9,
        minute: 0,
        weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
      },
    });
  });

  it("lets an app listener only pause and resume", async () => {
    const updateRoutine = vi.fn<TestRouteHandler>(() => reminder);
    const { cadence: _cadence, next_run_at: _next, ...base } = reminder;
    renderPanel(
      {
        listRoomRoutines: () => ({
          items: [
            { ...base, name: "Watch my inbox", listener: { app: "gmail" } },
          ],
          page: { has_more: false },
        }),
        updateRoutine,
      },
      false,
    );
    expect(await screen.findByText("Watching Gmail")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit routine" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete routine" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Watch my inbox"));
    expect(
      screen.queryByRole("heading", { name: "Edit routine" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Pause routine" }));
    await waitFor(() =>
      expect(updateRoutine).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { expected_revision: 1, enabled: false },
          params: { routineId: "routine_1" },
        }),
      ),
    );
  });

  it("hides automatically managed listeners in an Agent's routines", async () => {
    const { cadence: _cadence, next_run_at: _next, ...base } = reminder;
    renderPanel({
      listRoomRoutines: list([
        { ...base, name: "Watch my inbox", listener: { app: "gmail" } },
      ]),
    });
    expect(
      await screen.findByText("No routines in this room yet."),
    ).toBeVisible();
    expect(screen.queryByText("Watching Gmail")).toBeNull();
  });

  it("lists only this Agent's routines", async () => {
    renderPanel({
      listRoomRoutines: list([
        { ...reminder, id: "r1", name: "Created", instruction: "Created" },
        {
          ...reminder,
          id: "r2",
          name: "Mentioned",
          instruction: "Mentioned",
          created_by_actor_id: "human-1",
          mention_actor_id: AGENT,
        },
        {
          ...reminder,
          id: "r3",
          name: "Other",
          instruction: "Other",
          created_by_actor_id: "human-1",
        },
      ]),
    });
    expect(await screen.findByText("Created")).toBeVisible();
    expect(screen.getByText("Mentioned")).toBeVisible();
    expect(screen.queryByText("Other")).toBeNull();
  });

  it("offers to undo a pause for a few seconds", async () => {
    const paused = { ...reminder, enabled: false, revision: 2 };
    const updateRoutine = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce(paused)
      .mockReturnValueOnce({ ...reminder, revision: 3 });
    renderPanel({ listRoomRoutines: list([reminder]), updateRoutine });
    fireEvent.click(
      await screen.findByRole("switch", { name: "Pause routine" }),
    );
    const toast = await screen.findByRole("status");
    expect(toast).toHaveTextContent("Paused “Daily brief”");
    fireEvent.click(within(toast).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledTimes(2));
    expect(sentBody(updateRoutine, 1)).toEqual({
      expected_revision: 2,
      enabled: true,
    });
  });

  it("opens the time menu from the field and accepts typed times", async () => {
    renderPanel({ listRoomRoutines: list([]) });
    fireEvent.click(await screen.findByRole("button", { name: "New routine" }));
    const hour = screen.getByRole("textbox", { name: "Hour" });
    const minute = screen.getByRole("textbox", { name: "Minute" });
    fireEvent.focus(hour);
    expect(screen.getByRole("listbox", { name: "Hours" })).toBeVisible();
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Hours" })).getByRole(
        "option",
        { name: "14" },
      ),
    );
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Minutes" })).getByRole(
        "option",
        { name: "05" },
      ),
    );
    expect(hour).toHaveValue("14");
    expect(minute).toHaveValue("05");
    fireEvent.focus(hour);
    fireEvent.change(hour, { target: { value: "08" } });
    fireEvent.change(minute, { target: { value: "30" } });
    expect(hour).toHaveValue("08");
    expect(minute).toHaveValue("30");
    fireEvent.focus(hour);
    expect(screen.getByRole("listbox", { name: "Hours" })).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox", { name: "Hours" })).toBeNull();
  });
});

describe("weekly routine editing", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { timezone: "UTC", label: "Every day", kind: "daily" },
    { timezone: "UTC", label: "Every week", kind: "weekly" },
    { timezone: "America/New_York", label: "Every day", kind: "daily" },
    { timezone: "America/New_York", label: "Every week", kind: "weekly" },
  ])(
    "uses browser time when changing a $timezone interval to $kind",
    async ({ timezone, label, kind }) => {
      vi.spyOn(
        Intl.DateTimeFormat.prototype,
        "resolvedOptions",
      ).mockReturnValue({
        ...Intl.DateTimeFormat().resolvedOptions(),
        timeZone: "Asia/Shanghai",
      });
      const saved: TeamHubRoutine = {
        ...reminder,
        cadence: { kind: "every_n_hours", timezone, interval_hours: 4 },
      };
      const updateRoutine = vi.fn<TestRouteHandler>(() => saved);
      renderPanel({ listRoomRoutines: list([saved]), updateRoutine });
      const dialog = await openRoutine(/Daily brief/);
      await chooseWhen(dialog, label);
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(updateRoutine).toHaveBeenCalledTimes(1));
      expect(sentBody(updateRoutine, 0)).toMatchObject({
        cadence: {
          kind,
          timezone: "Asia/Shanghai",
          hour: 9,
          minute: 0,
        },
      });
    },
  );

  it("keeps saved weekdays and timezone when editing", async () => {
    const saved: TeamHubRoutine = {
      ...reminder,
      cadence: {
        kind: "weekly",
        timezone: "Pacific/Auckland",
        hour: 21,
        minute: 0,
        weekdays: ["monday", "wednesday", "friday"],
      },
    };
    const updateRoutine = vi.fn<TestRouteHandler>(() => saved);
    renderPanel({ listRoomRoutines: list([saved]), updateRoutine });
    await screen.findByText(/^Mon, Wed, Fri/);
    const dialog = await openRoutine(/Daily brief/);
    expect(
      within(dialog).getByRole("checkbox", { name: "Wednesday" }),
    ).toBeChecked();
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: "Wednesday" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledTimes(1));
    expect(sentBody(updateRoutine, 0)).toMatchObject({
      cadence: { weekdays: ["monday", "friday"], timezone: "Pacific/Auckland" },
    });
  });

  it("refuses to save a weekly routine with no weekday", async () => {
    const saved: TeamHubRoutine = {
      ...reminder,
      cadence: {
        kind: "weekly",
        timezone: "UTC",
        hour: 21,
        minute: 0,
        weekdays: ["friday"],
      },
    };
    const updateRoutine = vi.fn<TestRouteHandler>();
    renderPanel({ listRoomRoutines: list([saved]), updateRoutine });
    const dialog = await openRoutine(/Daily brief/);
    expect(
      within(dialog).getByRole("checkbox", { name: "Friday" }),
    ).toBeChecked();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Friday" }));
    expect(within(dialog).getByText("Choose a time")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Choose at least one weekday.",
    );
    expect(updateRoutine).not.toHaveBeenCalled();
  });
});
