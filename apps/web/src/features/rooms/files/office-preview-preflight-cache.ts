import officePreviewPreflightWorkerUrl from "./office-preview-preflight-worker.ts?worker&url";

// Retain code/module initialization only. Busy workers belong to one preview so
// cancellation or a stuck parser cannot interrupt a concurrent preview.
let idleWorker: Worker | undefined;

export function takeOfficePreviewPreflightWorker() {
  const worker = idleWorker;
  idleWorker = undefined;
  return (
    worker ?? new Worker(officePreviewPreflightWorkerUrl, { type: "module" })
  );
}

export function retainOfficePreviewPreflightWorker(worker: Worker) {
  // Concurrent previews may finish together; keep at most one idle worker.
  if (idleWorker) worker.terminate();
  else idleWorker = worker;
}
