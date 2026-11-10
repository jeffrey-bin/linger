import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRoomTimelineScroll } from "./use-room-timeline-scroll";

function Timeline({
  visible,
  scope,
  firstMessageId = "first",
  linkedMessageId = null,
  messageCount = 10,
  pendingMessageCount = 0,
  progressVersion = "",
  messageIds = [],
}: {
  visible: boolean;
  scope?: { accountId: string; tenantId: string; roomId: string };
  firstMessageId?: string;
  linkedMessageId?: string | null;
  messageCount?: number;
  pendingMessageCount?: number;
  progressVersion?: string;
  messageIds?: string[];
}) {
  const scroll = useRoomTimelineScroll({
    firstMessageId,
    linkedMessageId,
    linkedMessageReady:
      linkedMessageId !== null && messageIds.includes(linkedMessageId),
    messageCount,
    pendingMessageCount,
    progressVersion,
    scope,
  });
  return visible ? (
    <>
      <button onClick={scroll.prepareForOlderMessages}>Load older</button>
      <button
        onClick={() => {
          scroll.pinToLatest();
          if (scroll.timelineElement) {
            scroll.timelineElement.scrollTop =
              scroll.timelineElement.scrollHeight;
          }
        }}
      >
        Latest
      </button>
      <div
        aria-label="Room timeline"
        ref={scroll.timelineRef}
        onScroll={(event) => scroll.recordTimelineScroll(event.currentTarget)}
      >
        {messageIds.map((id) => (
          <div data-message-id={id} key={id}>
            {id}
          </div>
        ))}
      </div>
    </>
  ) : (
    <section>Voice focus</section>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Message deep-link positioning", () => {
  function setup() {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1000);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(200);
    return vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(function (this: HTMLElement) {
        this.parentElement!.scrollTop = 400;
      });
  }

  it.each([
    ["new messages", { messageCount: 11 }],
    ["pending messages", { pendingMessageCount: 1 }],
    ["streaming progress", { progressVersion: "tool-update" }],
  ])("preserves manual reading after %s", (_, update) => {
    const position = setup();
    const props = {
      visible: true,
      linkedMessageId: "target",
      messageIds: ["target"],
    };
    const view = render(<Timeline {...props} />);
    expect(position).toHaveBeenCalledTimes(1);
    expect(position).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });
    const timeline = screen.getByLabelText("Room timeline");
    timeline.scrollTop = 150;
    fireEvent.scroll(timeline);
    view.rerender(<Timeline {...props} {...update} />);
    expect(position).toHaveBeenCalledTimes(1);
    expect(timeline.scrollTop).toBe(150);
  });

  it("waits for an asynchronously loaded target before marking it positioned", () => {
    const position = setup();
    const view = render(<Timeline visible linkedMessageId="target" />);
    expect(position).not.toHaveBeenCalled();
    view.rerender(
      <Timeline visible linkedMessageId="target" messageIds={["target"]} />,
    );
    expect(position).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Room timeline").scrollTop).toBe(400);
    const timeline = screen.getByLabelText("Room timeline");
    timeline.scrollTop = 150;
    fireEvent.scroll(timeline);
    view.rerender(
      <Timeline
        visible
        linkedMessageId="target"
        progressVersion="next-tool"
        messageIds={["target"]}
      />,
    );
    expect(position).toHaveBeenCalledTimes(1);
    expect(timeline.scrollTop).toBe(150);
  });

  it("positions again when the Room or target changes, including returning to a previous link", () => {
    const position = setup();
    const scope = { accountId: "reader", tenantId: "space", roomId: "linked" };
    const props = { visible: true, scope, messageIds: ["one", "two"] };
    const view = render(<Timeline {...props} linkedMessageId="one" />);
    expect(position).toHaveBeenCalledTimes(1);
    view.rerender(<Timeline {...props} linkedMessageId="two" />);
    expect(position).toHaveBeenCalledTimes(2);
    view.rerender(
      <Timeline
        {...props}
        scope={{ ...scope, roomId: "other" }}
        linkedMessageId="two"
      />,
    );
    expect(position).toHaveBeenCalledTimes(3);
    view.rerender(<Timeline {...props} linkedMessageId="one" />);
    expect(position).toHaveBeenCalledTimes(4);
    view.rerender(<Timeline {...props} />);
    view.rerender(<Timeline {...props} linkedMessageId="one" />);
    expect(position).toHaveBeenCalledTimes(5);
  });

  it("allows returning to latest without a progress update repositioning the link", () => {
    const position = setup();
    const props = {
      visible: true,
      linkedMessageId: "target",
      messageIds: ["target"],
    };
    const view = render(<Timeline {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Latest" }));
    view.rerender(<Timeline {...props} progressVersion="next-tool" />);
    expect(position).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Room timeline").scrollTop).toBe(1000);
  });

  it("positions once after the timeline remounts without a navigation change", () => {
    const position = setup();
    const props = {
      visible: true,
      linkedMessageId: "target",
      messageIds: ["target"],
    };
    const view = render(<Timeline {...props} />);
    expect(position).toHaveBeenCalledTimes(1);
    view.rerender(<Timeline {...props} visible={false} />);
    view.rerender(<Timeline {...props} />);
    expect(position).toHaveBeenCalledTimes(2);
    view.rerender(<Timeline {...props} messageCount={11} />);
    expect(position).toHaveBeenCalledTimes(2);
  });

  it("preserves the prepend anchor after the linked target has been positioned", () => {
    const position = setup();
    let height = 1000;
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
      () => height,
    );
    const props = {
      visible: true,
      linkedMessageId: "target",
      messageIds: ["target"],
    };
    const view = render(<Timeline {...props} />);
    const timeline = screen.getByLabelText("Room timeline");
    timeline.scrollTop = 100;
    fireEvent.scroll(timeline);
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    height = 1500;
    view.rerender(
      <Timeline {...props} firstMessageId="older" messageCount={20} />,
    );
    expect(timeline.scrollTop).toBe(600);
    view.rerender(
      <Timeline {...props} firstMessageId="older" messageCount={21} />,
    );
    expect(timeline.scrollTop).toBe(600);
    expect(position).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary bottom following and stops following when the reader scrolls away", () => {
    setup();
    let height = 1000;
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
      () => height,
    );
    const view = render(<Timeline visible />);
    const timeline = screen.getByLabelText("Room timeline");
    height = 1200;
    view.rerender(<Timeline visible messageCount={11} />);
    expect(timeline.scrollTop).toBe(1200);
    timeline.scrollTop = 150;
    fireEvent.scroll(timeline);
    height = 1400;
    view.rerender(<Timeline visible messageCount={12} />);
    expect(timeline.scrollTop).toBe(150);
  });
});

describe("Room timeline remount", () => {
  it("restores a Room's reading position on return and isolates other Rooms and Accounts", () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1000);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(200);
    const scope = {
      accountId: "reader",
      tenantId: "space",
      roomId: "remember",
    };
    let view = render(<Timeline visible scope={scope} />);
    const timeline = screen.getByLabelText("Room timeline");
    timeline.scrollTop = 350;
    fireEvent.scroll(timeline);
    view.unmount();
    view = render(<Timeline visible scope={{ ...scope, roomId: "other" }} />);
    expect(screen.getByLabelText("Room timeline").scrollTop).toBe(1000);
    view.unmount();
    view = render(<Timeline visible scope={scope} />);
    expect(screen.getByLabelText("Room timeline").scrollTop).toBe(350);
    view.unmount();
    view = render(
      <Timeline visible scope={{ ...scope, accountId: "other" }} />,
    );
    expect(screen.getByLabelText("Room timeline").scrollTop).toBe(1000);
    view.unmount();
    render(<Timeline visible scope={scope} firstMessageId="history-changed" />);
    expect(screen.getByLabelText("Room timeline").scrollTop).toBe(1000);
  });

  it("returns to the latest messages after voice focus even when the message count is unchanged", () => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1000);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(200);
    const view = render(<Timeline visible />);
    expect(screen.getByLabelText("Room timeline").scrollTop).toBe(1000);
    view.rerender(<Timeline visible={false} />);
    view.rerender(<Timeline visible />);
    expect(screen.getByLabelText("Room timeline").scrollTop).toBe(1000);
  });
});

describe("Room timeline lane resize", () => {
  // jsdom has no layout: the lane width, row offsets and ResizeObserver are
  // driven by hand, one call per reflow of the narrowing lane.
  function setupLayout() {
    let notify: ResizeObserverCallback = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const layout = { width: 900, height: 1000, rowTops: [0, 400, 800] };
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
      () => layout.height,
    );
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(200);
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      () => layout.width,
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const timeline = this.closest('[aria-label="Room timeline"]')!;
        const index = ["a", "b", "c"].indexOf(
          this.getAttribute("data-message-id") ?? "",
        );
        const top = index < 0 ? 0 : layout.rowTops[index]! - timeline.scrollTop;
        return { top, bottom: top + 300 } as DOMRect;
      },
    );
    const reflow = (width: number, rowTops: number[], height: number) => {
      Object.assign(layout, { width, rowTops, height });
      const timeline = screen.getByLabelText("Room timeline");
      notify(
        [{ target: timeline } as unknown as ResizeObserverEntry],
        {} as never,
      );
    };
    return { layout, reflow };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the Message being read in place while the lane narrows", () => {
    const { reflow } = setupLayout();
    render(<Timeline visible messageIds={["a", "b", "c"]} />);
    const timeline = screen.getByLabelText("Room timeline");
    timeline.scrollTop = 450;
    fireEvent.scroll(timeline);
    // "b" starts 50px above the viewport; text above it rewraps taller.
    reflow(700, [0, 520, 980], 1200);
    expect(timeline.scrollTop).toBe(570);
    fireEvent.scroll(timeline);
    reflow(500, [0, 650, 1150], 1400);
    expect(timeline.scrollTop).toBe(700);
  });

  it("stays on the latest Message when its correction is reported after another reflow", () => {
    const { layout, reflow } = setupLayout();
    render(<Timeline visible messageIds={["a", "b", "c"]} />);
    const timeline = screen.getByLabelText("Room timeline");
    expect(timeline.scrollTop).toBe(1000);
    reflow(700, [0, 520, 980], 1200);
    expect(timeline.scrollTop).toBe(1200);
    // The text keeps rewrapping before the correction's scroll event is
    // handled, so the timeline no longer looks near its bottom.
    Object.assign(layout, { height: 1500 });
    fireEvent.scroll(timeline);
    reflow(500, [0, 650, 1150], 1500);
    expect(timeline.scrollTop).toBe(1500);
  });
});
