import { describe, expect, it } from "vitest";

import { canvasText, readCanvas } from "./canvas-document";

const code = (text: string, id = "block_canvas") => ({
  id,
  type: "codeBlock",
  content: [{ type: "text", text, styles: {} }],
});
const paragraph = (text: string) => ({
  id: "block_body",
  type: "paragraph",
  content: [{ type: "text", text, styles: {} }],
});

describe("readCanvas", () => {
  it("reads a Gmail canvas from its first code block", () => {
    const canvas = readCanvas([
      code(
        "canvas: gmail\nto: lisa@acme.com\ncc:\nsubject: Follow-up: pricing\nstatus: draft\nlink: https://mail.google.com/mail/#drafts\nexternal_id: r-1",
      ),
      paragraph("Hi Lisa,"),
    ]);
    expect(canvas).toMatchObject({
      blockId: "block_canvas",
      target: { id: "gmail", label: "Gmail" },
      fields: {
        to: "lisa@acme.com",
        cc: "",
        subject: "Follow-up: pricing",
        external_id: "r-1",
      },
      status: "draft",
      link: "https://mail.google.com/mail/#drafts",
    });
  });

  // The same cases as TeamHub's contract_server_agent_connector_gmail_canvas_test.go,
  // which reads the header with this syntax when it saves the draft.
  it.each([
    [
      "upper case",
      "Canvas: Gmail\nTO: a@b.co\nSubject: Hi",
      { to: "a@b.co", subject: "Hi" },
    ],
    ["one line", "canvas: gmail", {}],
    [
      "semicolons",
      "canvas: gmail\nto: a@b.co; c@d.co",
      { to: "a@b.co; c@d.co" },
    ],
    [
      "unknown fields",
      "canvas: gmail\nnote: keep\nx-y: dropped\nsubject: Old\nsubject: New",
      { note: "keep", subject: "New" },
    ],
  ])("reads the header like TeamHub: %s", (_case, text, fields) => {
    const canvas = readCanvas([code(text), paragraph("Hi")]);
    expect(canvas?.target.id).toBe("gmail");
    expect(canvas?.fields).toEqual(fields);
  });

  it("leaves ordinary Documents alone", () => {
    expect(readCanvas([paragraph("canvas: gmail")])).toBeUndefined();
    expect(readCanvas([code("const canvas = 1;")])).toBeUndefined();
    expect(readCanvas([paragraph("Intro"), code("canvas: gmail")])).toBe(
      undefined,
    );
    expect(readCanvas([])).toBeUndefined();
  });

  it("shows an unregistered target generically and ignores unsafe links", () => {
    const canvas = readCanvas([
      code(
        "canvas: slack\nchannel: #launch\nstatus: posted\nlink: javascript:alert(1)",
      ),
    ]);
    expect(canvas).toMatchObject({
      target: { id: "slack", label: "slack", fields: [] },
      fields: { channel: "#launch" },
      status: "editing",
    });
    expect(canvas?.link).toBeUndefined();
  });
});

describe("canvasText", () => {
  it("writes the header, target fields, status fields, then the rest", () => {
    const canvas = readCanvas([
      code(
        "canvas: gmail\nnote: keep\nstatus: draft\nsubject: Old\nto: a@b.co",
      ),
    ])!;
    expect(
      canvasText({
        ...canvas,
        fields: { ...canvas.fields, subject: "New\nline", cc: "c@d.co" },
      }),
    ).toBe(
      "canvas: gmail\nto: a@b.co\ncc: c@d.co\nsubject: New line\nstatus: draft\nnote: keep",
    );
  });

  it("round-trips through readCanvas", () => {
    const canvas = readCanvas([
      code("canvas: gmail\nto: a@b.co\ncc:\nsubject: Hi"),
    ])!;
    expect(readCanvas([code(canvasText(canvas))])?.fields).toEqual(
      canvas.fields,
    );
  });
});
