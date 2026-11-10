import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Also inherited by the file worker: model a slow filesystem, not slow code
// placed only in the old implementation's thread.
const append = fs.appendFileSync;
fs.appendFileSync = (...args) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  return append(...args);
};
syncBuiltinESMExports();
