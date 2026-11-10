// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  pageDataNote,
  readVoicePage,
  voicePageState,
} from "./voice-page-reader";

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 100,
    height: 20,
    top: 10,
    bottom: 30,
    left: 10,
    right: 110,
    x: 10,
    y: 10,
    toJSON: () => ({}),
  });
  document.title = "Apollo launch";
  document.body.innerHTML = `
    <nav aria-label="Primary navigation"><a href="/m">Message</a></nav>
    <main>
      <h1>Apollo launch</h1>
      <ul>
        <li>Ray Zhao 10:20 add tests before tomorrow's release</li>
        <li>Codex 10:21 <p>Build passed</p></li>
      </ul>
      <p>The release plan is still in review.</p>
      <textarea aria-label="Message Room">Unsent draft</textarea>
    </main>
    <section aria-label="Voice Mode window"><p>Text in the voice window</p></section>`;
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

describe("voice page reader", () => {
  it("numbers the visible content and leaves out navigation, drafts and the voice window", () => {
    const page = readVoicePage();
    expect(page).toContain("Page: Apollo launch (/)");
    expect(page).toContain("Viewing: Apollo launch");
    expect(page).toContain(pageDataNote);
    expect(page).toContain(
      "[2] Ray Zhao 10:20 add tests before tomorrow's release",
    );
    // A message is read once, not again through its paragraph.
    expect(page).toContain("[3] Codex 10:21 Build passed");
    expect(page).toContain("[4] The release plan is still in review.");
    expect(page).not.toContain("[5]");
    for (const hidden of [
      "Message",
      "Unsent draft",
      "Text in the voice window",
    ])
      expect(page).not.toContain(hidden);
  });

  it("puts what the Human selected into the page state", () => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("main > p")!);
    window.getSelection()!.addRange(range);
    const state = voicePageState();
    expect(state.text).toContain(
      "User's selection: The release plan is still in review.",
    );
    window.getSelection()!.removeAllRanges();
    expect(voicePageState().key).not.toBe(state.key);
  });

  it("reads a chat message with its author and time, once", () => {
    document.body.innerHTML = `
      <main>
        <article data-message-author="Wang">
          <div class="room-message-content">
            <div class="room-message-header"><button><span>Wang</span></button><time>10:02</time></div>
            <p>Review moved to three</p>
          </div>
        </article>
      </main>`;
    const page = readVoicePage();
    expect(page).toContain("[1] Wang (10:02): Review moved to three");
    expect(page).not.toContain("[2]");
  });

  it("keeps reading shorter blocks after one that does not fit", () => {
    // The tenth long block no longer fits; a short one after it still does.
    document.body.innerHTML = `<main>${Array.from(
      { length: 10 },
      (_, index) => `<p>${String(index).repeat(398)}</p>`,
    ).join("")}<p>Last sentence</p></main>`;
    const page = readVoicePage();
    expect(page).not.toContain("9".repeat(398));
    expect(page).toContain("Last sentence");
    expect(page).toContain("(More content further on was not read.)");
  });
});
