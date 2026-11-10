import { readConnectorFile, connectorTransferURL } from "./connector-files.js";
import {
  optionalFields,
  record,
  requiredString,
  type ConnectorRuntime,
  type Json,
} from "./connector-runtime.js";
import { array, id, object, rootSchema, str } from "./connector-schemas.js";
import {
  generationResume,
  savedFiles,
  saveRemoteFiles,
  type GenerationProvider,
} from "./connector-media.js";
import { cursor, nextCursor } from "./connector-runtime.js";
import { ConnectorError } from "./errors.js";

const tool = (name: string) => `HIGGSFIELD_MCP_${name}`;
const anyObject = { type: "object", additionalProperties: true };
// Higgsfield's job states, reported in the four states fal's queue uses. A
// job that ended without a result says why in error.
const jobStates: Record<string, { status: string; error?: string }> = {
  pending: { status: "queued" },
  waiting: { status: "queued" },
  queued: { status: "queued" },
  dna: { status: "running" },
  script: { status: "running" },
  visuals: { status: "running" },
  vision: { status: "running" },
  flow: { status: "running" },
  in_progress: { status: "running" },
  ip_detect: { status: "running" },
  completed: { status: "completed" },
  failed: { status: "failed", error: "The job failed on Higgsfield." },
  canceled: { status: "failed", error: "The job was canceled." },
  nsfw: {
    status: "failed",
    error: "Higgsfield blocked the result as unsafe content.",
  },
  ip_detected: {
    status: "failed",
    error:
      "Higgsfield blocked the result for third-party intellectual property.",
  },
};
interface ResolvedMedia {
  mediaId: string;
  type?: string;
  url?: string;
}

async function uploadFiles(
  paths: readonly string[],
  runtime: ConnectorRuntime,
): Promise<Map<string, ResolvedMedia>> {
  const files = paths.map((local) => {
    const file = runtime.files.find((item) => item.localPath === local);
    if (!file)
      throw new ConnectorError(
        "incomplete_response",
        "An input file snapshot is missing.",
      );
    return file;
  });
  const requested = await runtime.call(
    tool("MEDIA_UPLOAD"),
    {
      files: files.map((file) => ({
        filename: file.name,
        content_type: file.mimetype,
      })),
    },
    true,
  );
  const uploads = Array.isArray(requested.uploads)
    ? requested.uploads.map((item) => record(item, "upload target"))
    : [];
  if (uploads.length !== files.length)
    throw new ConnectorError(
      "incomplete_response",
      "Higgsfield did not return an upload target for every file.",
    );
  const result = new Map<string, ResolvedMedia & { type: string }>();
  for (const [index, file] of files.entries()) {
    const upload = uploads[index]!;
    const contentType = requiredString(
      upload.content_type,
      "upload content type",
    );
    let response: Response;
    try {
      response = await (runtime.context.fetch ?? globalThis.fetch)(
        connectorTransferURL(upload.upload_url),
        {
          method: "PUT",
          body: new Uint8Array(await readConnectorFile(file)),
          headers: { "content-type": contentType },
          redirect: "error",
          signal: AbortSignal.timeout(600000),
        },
      );
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(
        "file_transfer_failed",
        "A media file could not be uploaded.",
      );
    }
    await response.body?.cancel();
    if (!response.ok)
      throw new ConnectorError(
        "file_transfer_failed",
        "Higgsfield storage rejected a media upload.",
      );
    result.set(file.localPath, {
      mediaId: requiredString(upload.media_id, "media ID"),
      type: contentType.split("/", 1)[0]!,
      ...(typeof upload.url === "string" ? { url: upload.url } : {}),
    });
  }
  // Higgsfield confirms uploads one media type at a time.
  const byType = new Map<string, string[]>();
  for (const item of result.values())
    byType.set(item.type, [...(byType.get(item.type) ?? []), item.mediaId]);
  for (const [type, ids] of byType) {
    const confirmed = await runtime.call(
      tool("MEDIA_CONFIRM"),
      { type, media_ids: ids },
      true,
    );
    const rows = Array.isArray(confirmed.results)
      ? confirmed.results.map((item) => record(item, "upload confirmation"))
      : [];
    if (!ids.every((mediaId) => rows.some((row) => row.media_id === mediaId)))
      throw new ConnectorError(
        "incomplete_response",
        "Higgsfield did not confirm every uploaded file.",
      );
  }
  return result;
}

function jobView(raw: unknown): Json {
  const generation = record(raw, "job");
  const results =
    generation.results && typeof generation.results === "object"
      ? (generation.results as Json)
      : {};
  const status = requiredString(generation.status, "job status");
  const state = Object.hasOwn(jobStates, status)
    ? jobStates[status]
    : undefined;
  if (!state)
    throw new ConnectorError(
      "incomplete_response",
      "Higgsfield returned an unknown job status.",
    );
  return optionalFields({
    jobId: requiredString(generation.id, "job ID"),
    type: generation.type,
    model: generation.model,
    ...state,
    url: results.rawUrl,
    thumbnailUrl: results.thumbnailUrl ?? results.minUrl,
  });
}

/** Checks each job once and saves the results of those that completed. */
async function checkJobs(
  jobIds: readonly string[],
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const current = await Promise.all(
    jobIds.map(async (jobId) => {
      const status = await runtime.call(tool("JOB_STATUS"), {
        jobId,
        sync: false,
      });
      if (!status.generation)
        throw new ConnectorError(
          "not_found",
          "Higgsfield has no job with this ID.",
          { job_id: jobId },
        );
      return jobView(status.generation);
    }),
  );
  const open = current.filter(
    (item) => item.status === "queued" || item.status === "running",
  );
  const done = current.filter(
    (item) => item.status === "completed" && typeof item.url === "string",
  );
  // Saving waits for every job, so the same --output stays usable until then.
  const files =
    input.output && done.length && !open.length
      ? await saveRemoteFiles(
          done.map((item) => ({
            url: item.url as string,
            label: item.jobId as string,
          })),
          input.output as string,
          runtime.context,
        )
      : undefined;
  return optionalFields({
    jobs: current,
    files,
    nextCommand: open.length
      ? generationResume(
          input,
          runtime,
          open.map((item) => item.jobId as string),
        )
      : undefined,
  });
}

const jobRow = object(
  {
    jobId: id,
    type: str,
    model: str,
    status: { enum: ["queued", "running", "completed", "failed"] },
    error: str,
    url: str,
    thumbnailUrl: str,
  },
  ["jobId", "status"],
);
const jobsOutput = rootSchema(
  {
    jobs: array(jobRow),
    rejected: object({ error: str, reason: str, recoveryTool: str }, []),
    // Higgsfield's own question, passed through unchanged.
    unlimitedChoice: {},
    inputs: array(object({ source: id, mediaId: id }, ["source", "mediaId"])),
    adjustments: anyObject,
    warning: str,
    files: savedFiles,
    nextCommand: str,
  },
  ["jobs"],
);

export const higgsfieldGeneration: GenerationProvider = {
  outputSchema: jobsOutput,
  bindings(input) {
    if (input.mode === "price") return [tool("MODELS_EXPLORE")];
    if (input.mode === "job") return [tool("JOB_STATUS")];
    return [
      tool("MODELS_EXPLORE"),
      ...(input.files ? [tool("MEDIA_UPLOAD"), tool("MEDIA_CONFIRM")] : []),
      tool(input.type === "image" ? "GENERATE_IMAGE" : "GENERATE_VIDEO"),
    ];
  },
  execute: executeHiggsfield,
};

async function modelDetails(
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const model = await runtime.call(tool("MODELS_EXPLORE"), {
    action: "get",
    model_id: input.model,
  });
  if (model.id !== input.model)
    throw new ConnectorError(
      "not_found",
      "Higgsfield has no model with this ID.",
    );
  if (model.output_type !== input.type)
    throw new ConnectorError(
      "invalid_input",
      "This model does not generate the requested media type; select one from --price.",
    );
  return model;
}

async function prices(input: Json, runtime: ConnectorRuntime): Promise<Json> {
  let rows: Json[];
  let next: Json = { hasMore: false };
  if (input.model) rows = [await modelDetails(input, runtime)];
  else {
    const fp = {
      account: runtime.account.connection_id,
      type: input.type,
      limit: input.limit,
    };
    const raw = await runtime.call(
      tool("MODELS_EXPLORE"),
      optionalFields({
        action: "list",
        type: input.type,
        limit: input.limit,
        after: cursor(input.cursor, fp).token,
      }),
    );
    if (!Array.isArray(raw.items))
      throw new ConnectorError(
        "incomplete_response",
        "The model list is incomplete.",
      );
    const token = raw.next_page_token;
    if (
      token !== undefined &&
      token !== null &&
      token !== "" &&
      typeof token !== "string"
    )
      throw new ConnectorError(
        "incomplete_response",
        "The model list has an invalid next-page cursor.",
      );
    const hasMore =
      typeof token === "string" && token.length > 0 && raw.has_more !== false;
    if (raw.has_more === true && !hasMore)
      throw new ConnectorError(
        "incomplete_response",
        "The model list has more pages but no cursor.",
      );
    next = {
      hasMore,
      ...(hasMore ? { nextCursor: nextCursor({ token }, fp) } : {}),
    };
    rows = raw.items.map((row) => record(row));
    if (rows.some((row) => row.output_type !== input.type))
      throw new ConnectorError(
        "incomplete_response",
        "The provider returned a model with the wrong output type.",
      );
  }
  const models = rows.map((row) =>
    optionalFields({
      modelId: requiredString(row.id, "model ID"),
      name: row.name,
      description: row.description,
      outputType: row.output_type,
      ...(input.model
        ? optionalFields({
            parameters: row.parameters,
            medias: row.medias,
            aspectRatios: row.aspect_ratios,
            durations: row.durations,
            durationRange: row.duration_range,
            supportsUnlimited: row.supports_unlim,
          })
        : {}),
    }),
  );
  return {
    models,
    ...next,
    pricingStatus: "unavailable",
    warning:
      "Higgsfield's model catalog does not expose a price table. Prices are unavailable through this command; no estimate is substituted.",
  };
}

async function executeHiggsfield(
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  if (input.mode === "price") return prices(input, runtime);
  if (input.mode === "job")
    return checkJobs(input.jobIds as string[], input, runtime);
  await modelDetails(input, runtime);
  const files = (input.files ?? []) as { field: string; path: string }[];
  if (
    runtime.files.some(
      (file) => !/^(?:image|video|audio)\//u.test(file.mimetype),
    )
  )
    throw new ConnectorError(
      "invalid_input",
      "Higgsfield reference files must be images, videos or audio.",
    );
  const params: Json = { model: input.model, ...(input.parameters as Json) };
  const uploaded = files.length
    ? await uploadFiles([...new Set(files.map((file) => file.path))], runtime)
    : new Map<string, ResolvedMedia>();
  const inputs = files.length
    ? files.map((file) => ({
        source: file.path,
        mediaId: uploaded.get(file.path)!.mediaId,
      }))
    : undefined;
  if (files.length)
    params.medias = files.map((file) => ({
      role: file.field,
      value: uploaded.get(file.path)!.mediaId,
    }));
  const raw = await runtime.call(
    tool(input.type === "image" ? "GENERATE_IMAGE" : "GENERATE_VIDEO"),
    { params },
    true,
  );
  const rows: unknown[] = Array.isArray(raw.results) ? raw.results : [];
  // Preserve returned IDs even when another field or row is incomplete.
  const jobIds = rows.flatMap((row) => {
    const id = row && typeof row === "object" ? (row as Json).id : undefined;
    return typeof id === "string" && id.trim() ? [id] : [];
  });
  const nextCommand = jobIds.length
    ? generationResume(input, runtime, jobIds)
    : undefined;
  if (nextCommand) runtime.noteReceipt({ jobIds, nextCommand });
  const started = rows.map(jobView);
  if (!started.length && raw.unlim_choice !== undefined)
    return optionalFields({
      jobs: [],
      unlimitedChoice: raw.unlim_choice,
      warning:
        "Nothing was submitted. Ask the user whether to spend unlimited generations or credits, then rerun with --set use_unlim=true or --set use_unlim=false.",
      inputs,
    });
  if (!started.length) {
    const rejected = optionalFields({
      error: typeof raw.error === "string" ? raw.error : undefined,
      reason:
        typeof raw.recovery_reason === "string"
          ? raw.recovery_reason
          : undefined,
      recoveryTool:
        typeof raw.recovery_tool === "string" ? raw.recovery_tool : undefined,
    });
    if (!Object.keys(rejected).length)
      throw new ConnectorError(
        "incomplete_response",
        "Higgsfield returned neither a job nor a refusal; check the account before submitting again.",
      );
    return optionalFields({ jobs: [], rejected, inputs });
  }
  // The jobs run on Higgsfield; the caller checks them later with --job.
  return optionalFields({
    jobs: started,
    nextCommand,
    inputs,
    adjustments:
      raw.adjustments && typeof raw.adjustments === "object"
        ? raw.adjustments
        : undefined,
    warning: typeof raw.warning === "string" ? raw.warning : undefined,
  });
}
