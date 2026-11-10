import { afterEach, expect, it, vi } from "vitest";

vi.mock("./office-preview-frame-pptx.ts?worker&url", () => ({
  default: "/assets/office-preview-frame-pptx-hash.js",
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("shares concurrent and subsequent code loads without executing the renderer", async () => {
  vi.stubEnv("DEV", false);
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const { loadOfficePreviewFrameSource } =
    await import("./office-preview-frame-source");
  const first = loadOfficePreviewFrameSource("sample.pptx");
  expect(loadOfficePreviewFrameSource("sample.pptx")).toBe(first);
  const source = 'throw new Error("must never execute in parent");';
  resolve(new Response(source));
  await expect(first).resolves.toBe(source);
  await expect(loadOfficePreviewFrameSource("sample.pptx")).resolves.toBe(
    source,
  );
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "/assets/office-preview-frame-pptx-hash.js",
    {
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    },
  );
});

it.each(["network", "http", "body"])(
  "retries after a %s failure",
  async (failure) => {
    vi.stubEnv("DEV", false);
    const fetch = vi.fn();
    if (failure === "network")
      fetch.mockRejectedValueOnce(new Error("offline"));
    if (failure === "http")
      fetch.mockResolvedValueOnce(new Response("error", { status: 503 }));
    if (failure === "body")
      fetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.reject(new Error("interrupted")),
      });
    fetch.mockResolvedValueOnce(new Response("renderer"));
    vi.stubGlobal("fetch", fetch);
    const { loadOfficePreviewFrameSource } =
      await import("./office-preview-frame-source");
    await expect(loadOfficePreviewFrameSource("sample.pptx")).rejects.toThrow();
    await expect(loadOfficePreviewFrameSource("sample.pptx")).resolves.toBe(
      "renderer",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it("uses Vite's live graph in development", async () => {
  vi.stubEnv("DEV", true);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { loadOfficePreviewFrameSource } =
    await import("./office-preview-frame-source");
  await expect(
    loadOfficePreviewFrameSource("sample.pptx"),
  ).resolves.toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it("fetches only the selected format and keeps each format cached independently", async () => {
  vi.stubEnv("DEV", false);
  const fetch = vi.fn(async (url: string) => new Response(url));
  vi.stubGlobal("fetch", fetch);
  const { loadOfficePreviewFrameSource } =
    await import("./office-preview-frame-source");
  const pptx = loadOfficePreviewFrameSource("sample.pptx");
  const xlsx = loadOfficePreviewFrameSource("sample.xlsx");
  await Promise.all([pptx, xlsx]);
  expect(loadOfficePreviewFrameSource("another.PPTX")).toBe(pptx);
  expect(loadOfficePreviewFrameSource("another.xlsx")).toBe(xlsx);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[0]).toContain("office-preview-frame-pptx-");
  expect(fetch.mock.calls[1]?.[0]).toContain("office-preview-frame-xlsx");
});

it("does not evict another format when a request fails", async () => {
  vi.stubEnv("DEV", false);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response("presentation"))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(new Response("workbook"));
  vi.stubGlobal("fetch", fetch);
  const { loadOfficePreviewFrameSource } =
    await import("./office-preview-frame-source");
  const pptx = loadOfficePreviewFrameSource("sample.pptx");
  await pptx;
  await expect(loadOfficePreviewFrameSource("sample.xlsx")).rejects.toThrow(
    "offline",
  );
  expect(loadOfficePreviewFrameSource("sample.pptx")).toBe(pptx);
  await expect(loadOfficePreviewFrameSource("sample.xlsx")).resolves.toBe(
    "workbook",
  );
  expect(fetch).toHaveBeenCalledTimes(3);
});
