import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { modelPackageDirectory } from "../model-packages.js";
import { DocumentNormalizationError } from "./document-normalizer.js";

const require = createRequire(import.meta.url);

interface TessApi {
  Init(path: null, languages: string, engine: number): number;
  SetVariable(name: string, value: string): boolean;
  SetImageFile(orientation: number, angle: number): number;
  Recognize(monitor: null): number;
  GetUTF8Text(): string;
  End(): void;
}

interface TessCore {
  FS: {
    writeFile(path: string, bytes: Uint8Array): void;
    unlink(path: string): void;
  };
  TessBaseAPI: new () => TessApi;
  destroy(api: TessApi): void;
}

// Tesseract inserts spaces inside Chinese words. Keep line boundaries and Latin
// word spacing, but restore contiguous Han terms for exact search.
export function joinOcrHanRuns(text: string): string {
  return text.replace(/(\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, "$1");
}

// Run WASM in the normalizer's existing worker, so its hard deadline also stops
// OCR. No nested workers or host executable is needed. The language data comes
// from node_modules, or from the model packages the normalizer installs before
// it starts the worker when the runtime ships without them.
export class DocumentOcr {
  #core?: TessCore;
  #api?: TessApi;

  // Page segmentation mode 3 reads documents in layout order; 11 finds sparse
  // labels in screenshots where mode 3 sees no text block.
  async recognize(
    png: Uint8Array,
    pageSegMode: "3" | "11" = "3",
  ): Promise<string> {
    if (!this.#core || !this.#api) await this.#initialize();
    const core = this.#core!;
    const api = this.#api!;
    api.SetVariable("tessedit_pageseg_mode", pageSegMode);
    core.FS.writeFile("/input", png);
    try {
      if (api.SetImageFile(1, 0) !== 0 || api.Recognize(null) !== 0) {
        throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
      }
      return joinOcrHanRuns(api.GetUTF8Text()).trim();
    } finally {
      core.FS.unlink("/input");
    }
  }

  dispose(): void {
    if (this.#api) {
      this.#api.End();
      this.#core!.destroy(this.#api);
    }
    this.#api = undefined;
    this.#core = undefined;
  }

  async #initialize(): Promise<void> {
    try {
      const createCore =
        require("tesseract.js-core/tesseract-core-lstm.js") as (options: {
          print: () => void;
          printErr: () => void;
        }) => Promise<TessCore>;
      this.#core = await createCore({ print: () => {}, printErr: () => {} });
      for (const language of ["eng", "chi_sim"]) {
        const data = `@tesseract.js-data/${language}`;
        const file = `4.0.0_best_int/${language}.traineddata.gz`;
        const directory = modelPackageDirectory(data);
        const model = await readFile(
          directory
            ? path.join(directory, file)
            : require.resolve(`${data}/${file}`),
        );
        this.#core.FS.writeFile(`${language}.traineddata`, gunzipSync(model));
      }
      this.#api = new this.#core.TessBaseAPI();
      if (this.#api.Init(null, "eng+chi_sim", 1) !== 0)
        throw new Error("OCR init");
    } catch {
      this.dispose();
      throw new DocumentNormalizationError(
        "DOCUMENT_NORMALIZATION_UNAVAILABLE",
      );
    }
  }
}
