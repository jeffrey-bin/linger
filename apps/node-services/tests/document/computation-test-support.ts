import { afterAll } from "vitest";

import {
  createDocumentComputationPool,
  type DocumentComputation,
} from "../../src/document/computation-pool.js";

export function useDocumentComputation(): DocumentComputation {
  const computation = createDocumentComputationPool({ size: 1 });
  afterAll(async () => {
    await computation.close();
  });
  return computation;
}
