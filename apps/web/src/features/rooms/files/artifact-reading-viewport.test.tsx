import { fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { ArtifactReadingViewport } from "./artifact-reading-viewport";

it("restores available content and saves subsequent reading without resetting on rerender", async () => {
  const position = { scrollTop: 450, scrollLeft: 12 };
  const view = render(
    <ArtifactReadingViewport position={position}>
      <div>Loading</div>
    </ArtifactReadingViewport>,
  );
  const host = view.container.firstElementChild as HTMLDivElement;
  expect(host.scrollTop).toBe(450);
  expect(host.scrollLeft).toBe(12);
  host.scrollTop = 630;
  fireEvent.scroll(host);
  expect(position.scrollTop).toBe(630);
  view.rerender(
    <ArtifactReadingViewport position={position}>
      <div>Loaded</div>
    </ArtifactReadingViewport>,
  );
  await waitFor(() => expect(host.scrollTop).toBe(630));
  view.unmount();
  const reopened = render(
    <ArtifactReadingViewport position={position}>
      Content
    </ArtifactReadingViewport>,
  );
  expect(reopened.container.firstElementChild?.scrollTop).toBe(630);
});

function renderPendingImage() {
  const position = { scrollTop: 720, scrollLeft: 0 };
  const content = <img alt="Tall diagram" src="/tall.png" />;
  const view = render(
    <ArtifactReadingViewport>{content}</ArtifactReadingViewport>,
  );
  const host = view.container.firstElementChild as HTMLDivElement;
  let maxScrollTop = 0;
  let scrollTop = 0;
  // JSDOM has no layout: model the browser clamping offsets before an image
  // gives the document enough height to reach the saved position.
  Object.defineProperty(host, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.min(value, maxScrollTop);
    },
  });
  view.rerender(
    <ArtifactReadingViewport position={position}>
      {content}
    </ArtifactReadingViewport>,
  );
  return {
    ...view,
    host,
    position,
    image: view.getByRole("img"),
    setMaxScrollTop(value: number) {
      maxScrollTop = value;
    },
  };
}

it("retries a clamped position when an image loads without a DOM or viewport resize", () => {
  const { host, image, position, setMaxScrollTop } = renderPendingImage();
  expect(host.scrollTop).toBe(0);
  fireEvent.scroll(host);
  expect(position.scrollTop).toBe(720);

  setMaxScrollTop(2000);
  fireEvent.load(image); // Native image load does not bubble.
  expect(host.scrollTop).toBe(720);

  host.scrollTop = 900;
  fireEvent.scroll(host);
  fireEvent.load(image);
  expect(position.scrollTop).toBe(900);
  expect(host.scrollTop).toBe(900);
});

it.each(["wheel", "pointerdown", "keydown"])(
  "lets %s cancel a pending restore before a late image loads",
  (eventType) => {
    const { host, image, position, setMaxScrollTop } = renderPendingImage();
    setMaxScrollTop(300);
    fireEvent(host, new Event(eventType, { bubbles: true }));
    host.scrollTop = 200;
    fireEvent.scroll(host);
    setMaxScrollTop(2000);
    fireEvent.load(image);
    expect(host.scrollTop).toBe(200);
    expect(position.scrollTop).toBe(200);
  },
);

it("does not restore or save a disposed viewport when a pending image loads", () => {
  const { host, image, position, setMaxScrollTop, unmount } =
    renderPendingImage();
  unmount();
  setMaxScrollTop(2000);
  fireEvent.load(image);
  fireEvent.scroll(host);
  expect(host.scrollTop).toBe(0);
  expect(position.scrollTop).toBe(720);
});
