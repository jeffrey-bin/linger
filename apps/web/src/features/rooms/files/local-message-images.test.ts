import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_MESSAGE_IMAGE_LIMIT,
  decodeLocalImage,
  localMessageImage,
  releaseLocalImage,
  rememberLocalMessageImage,
} from "./local-message-images";

describe("local message images", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubDecoding() {
    let next = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => `blob:image-${next++}`,
    );
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    vi.stubGlobal(
      "Image",
      class {
        naturalHeight = 10;
        naturalWidth = 20;
        onload: () => void = () => undefined;
        onerror: () => void = () => undefined;
        set src(_url: string) {
          queueMicrotask(() => this.onload());
        }
      },
    );
    return revoke;
  }

  it("keeps only the most recent sent images and frees the oldest", async () => {
    const revoke = stubDecoding();
    const sent = Array.from(
      { length: LOCAL_MESSAGE_IMAGE_LIMIT + 1 },
      (_, index) => new File(["x"], `${index}.png`, { type: "image/png" }),
    );
    const urls = await Promise.all(
      sent.map(async (file, index) => {
        const image = await decodeLocalImage(file);
        rememberLocalMessageImage(`document-${index}`, file);
        return image.url;
      }),
    );

    expect(localMessageImage("document-0")).toBeUndefined();
    expect(localMessageImage("document-1")).toBe(sent[1]);
    expect(revoke).toHaveBeenCalledExactlyOnceWith(urls[0]);
  });

  it("frees a picked image that is removed, even mid-decode", async () => {
    const revoke = stubDecoding();
    const file = new File(["x"], "picked.png", { type: "image/png" });
    const decoding = decodeLocalImage(file);
    releaseLocalImage(file);
    const image = await decoding;

    expect(revoke).toHaveBeenCalledExactlyOnceWith(image.url);
    // A later pick decodes it again with a fresh URL.
    expect((await decodeLocalImage(file)).url).not.toBe(image.url);
  });
});
