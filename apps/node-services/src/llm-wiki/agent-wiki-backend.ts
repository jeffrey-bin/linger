import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { degradeInvalidMermaidFences } from "openwiki/dist/mermaid/validate.js";
import { parse as parseYaml } from "yaml";
import { isRecord } from "@linger/service-kit";

import {
  estimateTokens,
  runAgentTask,
  strictObject,
  taskTokens,
  type AgentEnvironment,
  type AgentObservation,
  type AgentTask,
  type AgentTool,
} from "../memory-agent.js";
import { searchBm25 } from "../bm25.js";
import { promptsRoot } from "../paths.js";
import {
  ModelCallError,
  type ModelCall,
  type ModelChain,
} from "../runtime-model-call.js";
import type {
  LlmWikiBackend,
  LlmWikiGenerateRequest,
  LlmWikiGenerateResult,
  WikiInput,
} from "./backend.js";
import {
  checkpointTree,
  isWikiPageKey,
  scanGeneratedWiki,
} from "./actor-wiki/wiki-workspace.js";
import { ActorAssetError } from "./actor-wiki/actor-asset-client.js";
import { wikiLogger, writeWikiLog } from "./log.js";
import {
  PERSONAL_WIKI_ENTITY_TYPES,
  PERSONAL_WIKI_NODE_TYPES,
  formatPersonalWikiNodeTypeInstruction,
  personalWikiEntityRules,
  personalWikiIdentityRules,
  type PersonalWikiNodeType,
  type PersonalWikiNodeTypeId,
} from "./personal-wiki-node-types.js";
import {
  canonicalRawSourceUrl,
  rawSourceReference,
  wikiSourceReferences,
} from "./personal-wiki-policy.js";
import { recoverOptionalWikiPages } from "./wiki-candidate-recovery.js";
import {
  assertValidWikiCandidate,
  identityKey,
  inspectWikiCandidate,
  normalizeWikiCandidate,
  WikiCandidateValidationError,
  type WikiCandidateIssue,
} from "./wiki-candidate-validation.js";
import {
  existingTeamHubSourceUrlsByPage,
  generationInvocationError,
  isIndexPage,
  logGenerationStep,
  makeTreeWritable,
  normalizeChangedMemoryNodeMetadata,
  pathExists,
  removeOmittedPersonalPages,
  safeRunError,
  synchronizeWikiIndexes,
} from "./wiki-candidate-tree.js";
import {
  readEntityIndex,
  renderEntityRegistry,
  type WikiEntityEntry,
} from "./wiki-entity-registry.js";
import {
  renderWikiPage,
  strictWikiPageSchema,
  validateWikiPageTemplate,
  wikiPageForModel,
  wikiPageFromStrictPayload,
} from "./wiki-page-template.js";

/**
 * Generates a Wiki candidate with the memory Agent (src/memory-agent.ts).
 * Routing tasks read the changed chats and Documents once and name the
 * entities they support; a meeting task writes each meeting's Session page
 * and routes its entities; then one entity task per page writes that page
 * from the evidence routed to it. Every write is page JSON that
 * `renderWikiPage` checks and renders; the candidate is validated as a whole
 * before it is returned. Room chats get no Session page: what they say lives
 * on entity pages and in Daily reports.
 */

/** One step's model call. A normal step answers in one or two minutes; a
 * step past this is retried within the Wiki kind's attempts, then its batch
 * is skipped. The refresh deadline still bounds the whole generation. */
const STEP_TIMEOUT_MS = 15 * 60_000;
/** Characters one step may stream: three times its output budget at four
 * characters a token, so only a reply that runs away is stopped. */
function outputCapChars(tokens: number): number {
  return 3 * tokens * 4;
}
const MIN_EVIDENCE_TOKENS = 4_000;
/** Characters per token when a token budget becomes a character budget. */
const CHARS_PER_TOKEN = 3;
/** Halvings of a routing pack or an entity's evidence after a prompt is too large. */
const MAX_SPLITS = 3;

/** Steps, actions and the room one step's reply and results take, by task;
 * a batch's reply is up to `output` per page. */
const LIMITS = {
  route: { steps: 2, actions: 40, output: 3_000, result: 2_000 },
  consolidate: { steps: 2, actions: 40, output: 2_000, result: 1_000 },
  meeting: { steps: 3, actions: 30, output: 8_000, result: 2_000 },
  batch: { steps: 4, actions: 16, output: 3_000, result: 4_000 },
} as const;
/** Entity pages one task writes at most. */
const MAX_BATCH_PAGES = 5;
/** Existing entities a routing task sees when the Wiki has more. */
const MAX_CANDIDATES = 40;
/** Existing entities the consolidation step sees. */
const MAX_CONSOLIDATION_PAGES = 300;

type EntityTypeId = Exclude<PersonalWikiNodeTypeId, "session">;

interface EvidenceUnit {
  readonly refs: readonly string[];
  readonly text: string;
}

/** One changed source as the tasks read it. */
interface EvidenceSource {
  /** The input's asset key; tasks name sources by it. */
  readonly id: string;
  readonly title: string;
  readonly kind: "chat" | "meeting" | "document";
  readonly date: string | undefined;
  /** Who the Session belongs to, when it is a Session. */
  readonly human: string | undefined;
  readonly input: WikiInput;
  /** Messages of a chat; paragraphs of a meeting or Document. */
  readonly units: readonly EvidenceUnit[];
}

interface EntityTodo {
  readonly type: EntityTypeId;
  /** The existing page, when the entity has one. */
  page: string | undefined;
  readonly name: string;
  readonly slug: string | undefined;
  readonly refs: Set<string>;
  readonly notes: string[];
}

/** One meeting's Session page task. */
interface PageTask {
  readonly path: string;
  readonly definition: PersonalWikiNodeType;
  /** Builds the task input around the transcript, or one part of it. */
  readonly input: (transcript: string, issues?: string) => string;
  /** The sources `read_source` may page through. */
  readonly sources: readonly EvidenceSource[];
}

/** One entity page a batch writes. */
interface PagePlan {
  readonly path: string;
  readonly todo: EntityTodo;
  readonly definition: PersonalWikiNodeType;
  readonly existing: boolean;
  /** Citations of deleted sources the page must drop. */
  readonly removedRefs: readonly string[] | undefined;
  readonly related: readonly { path: string; name: string }[];
}

/** Entity pages written by one task from their shared evidence. */
interface PageBatch {
  readonly pages: readonly PagePlan[];
  readonly refs: ReadonlySet<string>;
  readonly sources: readonly EvidenceSource[];
}

export interface AgentWikiBackendOptions {
  modelCall: () => ModelCall | undefined;
}

export class AgentWikiBackend implements LlmWikiBackend {
  readonly id = "agent";
  readonly generationKey = agentWikiGenerationKey();
  readonly #modelCall: () => ModelCall | undefined;

  constructor(options: AgentWikiBackendOptions) {
    this.#modelCall = options.modelCall;
  }

  async generate(
    request: LlmWikiGenerateRequest,
  ): Promise<LlmWikiGenerateResult> {
    const startedAt = Date.now();
    const runId = randomUUID();
    let isolatedRoot: string | undefined;
    try {
      const modelCall = this.#modelCall();
      if (!modelCall)
        throw new ActorAssetError(
          "WIKI_OPERATION_RETRYABLE",
          "Wiki generation needs the agent role in this process",
          "retryable",
        );
      isolatedRoot = await mkdtemp(join(tmpdir(), "llm-wiki-agent-"));
      const directory = join(isolatedRoot, "wiki");
      if (await pathExists(request.existingOutputDirectory)) {
        await cp(request.existingOutputDirectory, directory, {
          recursive: true,
        });
        await makeTreeWritable(directory);
      }
      await mkdir(directory, { recursive: true });
      // Links to pages that are gone (such as deleted chat Session pages) are
      // dropped before the baseline is taken, so dropping them does not count
      // as changing a page this run did not write.
      await normalizeWikiCandidate(directory);
      await synchronizeWikiIndexes(directory);
      // Each model task takes half of the Another Me model's context window.
      const contextWindow = await modelCall.contextWindow?.(
        { anotherMe: request.generator },
        request.signal,
      );
      const generation = await Generation.prepare(
        request,
        directory,
        taskTokens(contextWindow),
        runId,
      );
      logGenerationStep("prepare_workspace", startedAt, {
        context_window: contextWindow,
      });
      // Each routing pack, meeting, page batch and correction is its own
      // queued chain, so other model work runs between them.
      const key = `wiki:${request.generationId ?? `manual_${runId.replaceAll("-", "")}`}`;
      const result = await generation.run((step, body) =>
        modelCall.chain(
          {
            kind: "wiki",
            key: `${key}/${step}`,
            anotherMe: request.generator,
            signal: generation.signal,
          },
          body,
        ),
      );
      if (await pathExists(request.outputDirectory))
        throw new Error(
          `Wiki candidate output already exists: ${request.outputDirectory}`,
        );
      await mkdir(dirname(request.outputDirectory), { recursive: true });
      await cp(directory, request.outputDirectory, { recursive: true });
      wikiLogger().log("info", "wiki.generation_phase", {
        phase: "complete",
        duration_ms: Date.now() - startedAt,
        page_count: result.pageCount,
        unsettled_source_count: result.unsettled.length,
      });
      return result;
    } catch (error) {
      writeWikiLog(
        "llm_wiki_generation_failed",
        {
          generation_id: request.generationId,
          run_id: runId,
          error: safeRunError(error),
        },
        "ERROR",
      );
      throw error;
    } finally {
      if (isolatedRoot)
        await rm(isolatedRoot, { recursive: true, force: true });
    }
  }
}

/** Runs body as one queued chain of this generation's model calls. */
type WikiChain = <T>(
  step: string,
  body: (model: ModelChain) => Promise<T>,
) => Promise<T>;

/** One candidate generation: its evidence, catalog and tasks. */
class Generation {
  readonly #todos = new Map<string, EntityTodo>();
  /** Every meeting task of this run by its page, for corrections. */
  readonly #meetings = new Map<string, PageTask>();
  /** The batch that wrote each entity page, for corrections. */
  readonly #batchOf = new Map<string, PageBatch>();
  /** Sources a task over them failed to write, by id; TeamHub keeps them
   * pending and counts the try. */
  readonly #unsettled = new Set<string>();
  /** Sources left unwritten only because the deadline passed; TeamHub keeps
   * them pending without counting a try. */
  readonly #deferred = new Set<string>();
  readonly #abort = new AbortController();
  #chain: WikiChain | undefined;

  private constructor(
    readonly request: LlmWikiGenerateRequest,
    readonly directory: string,
    readonly loopTokens: number,
    readonly runId: string,
    readonly sources: readonly EvidenceSource[],
    readonly references: ReadonlyMap<string, string>,
    readonly baseline: ReadonlyMap<string, string>,
    readonly existingUrls: ReadonlyMap<string, string[]>,
    readonly entities: readonly WikiEntityEntry[],
  ) {
    if (request.signal?.aborted) this.#abort.abort();
    request.signal?.addEventListener("abort", () => this.#abort.abort(), {
      once: true,
    });
  }

  static async prepare(
    request: LlmWikiGenerateRequest,
    directory: string,
    loopTokens: number,
    runId: string,
  ): Promise<Generation> {
    const baseline = await checkpointTree(directory);
    const existingUrls = await existingTeamHubSourceUrlsByPage(
      directory,
      baseline.keys(),
    );
    const changed = [...request.changes.added, ...request.changes.modified];
    const sources = await Promise.all(
      changed.map((input) => readEvidence(request.inputsDirectory, input)),
    );
    const references = wikiSourceReferences(request.changes, [
      ...changed.flatMap((input) =>
        input.session ? input.session.citations : [input.sourceUrl],
      ),
      ...[...existingUrls.values()].flat(),
    ]);
    return new Generation(
      request,
      directory,
      loopTokens,
      runId,
      sources,
      references,
      baseline,
      existingUrls,
      await readEntityIndex(directory),
    );
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  async run(chain: WikiChain): Promise<LlmWikiGenerateResult> {
    this.#chain = chain;
    const routedAt = Date.now();
    await this.#routeAll();
    logGenerationStep("route", routedAt, { todo_count: this.#todos.size });
    const consolidatedAt = Date.now();
    const merged = await this.#consolidate();
    logGenerationStep("consolidate", consolidatedAt, {
      merged_count: merged,
      todo_count: this.#todos.size,
    });
    const pagesAt = Date.now();
    const batches = this.#pageBatches(this.#pagePlans());
    await this.#each(
      batches,
      (_batch, index) => `batch:${index + 1}`,
      (model, batch, step) => this.#writeBatch(model, batch, step),
    );
    logGenerationStep("write_pages", pagesAt, {
      page_count: this.#batchOf.size,
      batch_count: batches.length,
    });
    const pageCount = await this.#finish();
    return {
      pageCount,
      unsettled: [...this.#unsettled],
      deferred: [...this.#deferred].filter((id) => !this.#unsettled.has(id)),
    };
  }

  /** Past the refresh deadline no further task or step starts. */
  #expired(): boolean {
    return (
      this.request.deadline !== undefined && Date.now() >= this.request.deadline
    );
  }

  /**
   * Leaves these sources out of the publication's settled sources: TeamHub
   * keeps them pending, so a later refresh writes what this one skipped. A
   * skip only because the deadline passed is no failure of the source and
   * spends none of its tries.
   */
  #unsettle(
    event: string,
    sources: readonly EvidenceSource[],
    fields: Readonly<Record<string, unknown>>,
  ): void {
    const left =
      fields.reason === "deadline" ? this.#deferred : this.#unsettled;
    for (const source of sources) left.add(source.id);
    writeWikiLog(
      event,
      {
        run_id: this.runId,
        ...fields,
        sources: [...new Set(sources.map((source) => source.id))],
      },
      "ERROR",
    );
  }

  /** Routes every chat and Document, and writes every meeting's Session page. */
  async #routeAll(): Promise<void> {
    const meetings = this.sources.filter((source) => source.kind === "meeting");
    const routed = this.sources.filter((source) => source.kind !== "meeting");
    const task = routeTask();
    const evidenceTokens = Math.max(
      MIN_EVIDENCE_TOKENS,
      this.loopTokens -
        estimateTokens(task.instructions) -
        estimateTokens(
          renderEntityRegistry(this.entities.slice(0, MAX_CANDIDATES)),
        ) -
        LIMITS.route.steps * (LIMITS.route.output + LIMITS.route.result),
    );
    const packs = packEvidence(routed, evidenceTokens);
    await this.#each(
      packs,
      (_pack, index) => `route:${index + 1}`,
      (model, pack, step) => this.#route(model, pack, step, 0),
    );
    await this.#each(
      meetings.map((meeting) =>
        this.#meetingTask(meeting, this.#registryFor([meeting])),
      ),
      (task) => `meeting:${task.path}`,
      (model, task) => this.#writeMeeting(model, task),
    );
  }

  /** The existing entities a task over these sources sees (MAX_CANDIDATES). */
  #registryFor(sources: readonly EvidenceSource[]): string {
    return renderEntityRegistry(
      candidateEntities(
        this.entities,
        sources.map((source) => renderSource(source)).join("\n\n"),
      ),
    );
  }

  async #route(
    model: ModelChain,
    pack: readonly EvidenceSource[],
    step: string,
    splits: number,
  ): Promise<void> {
    if (this.#expired()) {
      this.#unsettle("wiki_route_skipped", pack, { step, reason: "deadline" });
      return;
    }
    const registry = this.#registryFor(pack);
    const refs = new Set(pack.flatMap(sourceRefs));
    const startedAt = Date.now();
    try {
      const result = await runAgentTask({
        model,
        step,
        task: routeTask(),
        maxInputTokens: this.loopTokens,
        deadline: this.request.deadline,
        input: `${registry}\n# Evidence\n\n${pack.map((source) => renderSource(source)).join("\n\n")}`,
        environment: this.#todoEnvironment(refs),
        signal: this.signal,
      });
      this.#logTask("wiki.route", result, startedAt);
      if (!result.finished && this.#expired())
        this.#unsettle("wiki_route_skipped", pack, {
          step,
          reason: "deadline",
        });
    } catch (error) {
      if (tooLarge(error) && splits < MAX_SPLITS && pack.length > 1) {
        const half = Math.ceil(pack.length / 2);
        await this.#route(model, pack.slice(0, half), `${step}a`, splits + 1);
        await this.#route(model, pack.slice(half), `${step}b`, splits + 1);
        return;
      }
      // A step that stalled past its attempts, or a prompt still too large
      // after its halvings, would fail again: its sources wait for a later
      // refresh and the rest of this one still publishes.
      if (!skippable(error) || this.signal.aborted) throw error;
      this.#unsettle("wiki_route_skipped", pack, {
        step,
        reason: (error as ModelCallError).kind,
      });
    }
  }

  #meetingTask(meeting: EvidenceSource, registry: string): PageTask {
    const routing = meeting.input.session!;
    const definition = PERSONAL_WIKI_NODE_TYPES.get("session")!;
    const sessionId = routing.targetPath.split("/").at(-1)!.slice(0, -3);
    return {
      path: routing.targetPath,
      definition,
      sources: [meeting],
      input: (transcript, issues) =>
        `# Session page

Path: ${routing.targetPath}
Fields: session_id = ${sessionId}, date = ${routing.date}, source_kind = meeting
${issues ? `\n# Issues to fix\n\n${issues}\n` : ""}
${registry}
# Meeting transcript

${transcript}`,
    };
  }

  /** Every routed entity's page, plus pages whose sources were removed. */
  #pagePlans(): PagePlan[] {
    const paths = new Map<EntityTodo, string>();
    const taken = new Set<string>();
    for (const todo of this.#todos.values()) {
      const path = todo.page ?? this.#newPagePath(todo, taken);
      taken.add(path);
      paths.set(todo, path);
    }
    const removedUrls = new Set(
      this.request.changes.removed.map((source) =>
        canonicalRawSourceUrl(source.sourceUrl),
      ),
    );
    const removed = new Map<string, string[]>();
    for (const [page, urls] of this.existingUrls) {
      const gone = urls.filter((url) => removedUrls.has(url));
      if (gone.length && this.entities.some((entry) => entry.path === page))
        removed.set(page, gone.map(rawSourceReference));
    }
    for (const page of removed.keys()) {
      if ([...paths.values()].includes(page)) continue;
      const entry = this.entities.find((candidate) => candidate.path === page)!;
      paths.set(
        {
          type: entry.type as EntityTypeId,
          page,
          name: entry.name,
          slug: undefined,
          refs: new Set(),
          notes: [],
        },
        page,
      );
    }
    return [...paths].map(([todo, path]) => {
      const related = [...paths]
        .filter(
          ([other, otherPath]) =>
            other !== todo &&
            otherPath !== path &&
            [...other.refs].some((ref) => todo.refs.has(ref)),
        )
        .map(([other, otherPath]) => ({
          path: otherPath,
          name: other.page ? other.name : `${other.name} (new in this run)`,
        }));
      return {
        path,
        todo,
        definition: PERSONAL_WIKI_NODE_TYPES.get(todo.type)!,
        existing: this.baseline.has(path),
        removedRefs: removed.get(path),
        related,
      };
    });
  }

  /**
   * Groups pages that cite the same messages, then packs groups into batches
   * of at most MAX_BATCH_PAGES that fit one loop: instructions, current pages,
   * a share of evidence and the room each step's reply and results take.
   */
  #pageBatches(plans: readonly PagePlan[]): PageBatch[] {
    const groups: PagePlan[][] = [];
    for (const plan of plans) {
      const joined = groups.filter((group) =>
        group.some((other) =>
          [...other.todo.refs].some((ref) => plan.todo.refs.has(ref)),
        ),
      );
      const merged = [plan, ...joined.flat()];
      for (const group of joined) groups.splice(groups.indexOf(group), 1);
      groups.push(merged);
    }
    const batches: PagePlan[][] = [];
    for (const group of groups) {
      for (let start = 0; start < group.length; start += MAX_BATCH_PAGES) {
        const pages = group.slice(start, start + MAX_BATCH_PAGES);
        const last = batches.at(-1);
        if (
          last &&
          last.length + pages.length <= MAX_BATCH_PAGES &&
          this.#fits([...last, ...pages])
        )
          last.push(...pages);
        else {
          // A new batch also leaves room for evidence: pages whose current
          // text is large go in smaller batches, down to one page each.
          for (const page of pages) {
            const open = batches.at(-1);
            if (open && open !== last && this.#fits([...open, page]))
              open.push(page);
            else batches.push([page]);
          }
        }
      }
    }
    return batches.map((pages) => this.#batch(pages));
  }

  /** Whether one loop holds these pages with room for some evidence. */
  #fits(pages: readonly PagePlan[]): boolean {
    return (
      this.#batchFixedTokens(pages) + MIN_EVIDENCE_TOKENS * 2 <= this.loopTokens
    );
  }

  #batch(pages: readonly PagePlan[]): PageBatch {
    const refs = new Set(pages.flatMap((page) => [...page.todo.refs]));
    return {
      pages,
      refs,
      sources: this.sources.filter((source) =>
        sourceRefs(source).some((ref) => refs.has(ref)),
      ),
    };
  }

  /** Everything a batch's loop holds except its evidence. */
  #batchFixedTokens(pages: readonly PagePlan[]): number {
    return (
      estimateTokens(batchTask(pages).instructions) +
      pages.reduce(
        (sum, page) => sum + estimateTokens(this.#current(page.path) ?? ""),
        0,
      ) +
      batchReserveTokens(pages.length)
    );
  }

  /** The published page this run updates; corrections compare against it too. */
  #previous(path: string): string | undefined {
    return this.baseline.has(path)
      ? readFileSync(join(this.request.existingOutputDirectory, path), "utf8")
      : undefined;
  }

  /** The published page as its writer sees it. */
  #current(path: string): string | undefined {
    const previous = this.#previous(path);
    return previous && wikiPageForModel(path, previous, this.references);
  }

  /** Writes a batch's pages, halving its evidence and then the batch when
   * the prompt is too large. */
  async #writeBatch(
    model: ModelChain,
    batch: PageBatch,
    step: string,
    issues?: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const page of batch.pages) this.#batchOf.set(page.path, batch);
    const skip = (reason: string, pages = batch.pages) =>
      this.#unsettle("wiki_batch_skipped", this.#batch(pages).sources, {
        step,
        reason,
        pages: pages.map((page) => page.path),
      });
    if (this.#expired()) {
      skip("deadline");
      return;
    }
    const task = batchTask(batch.pages);
    let evidenceTokens = Math.max(
      MIN_EVIDENCE_TOKENS,
      this.loopTokens - this.#batchFixedTokens(batch.pages),
    );
    for (let splits = 0; ; splits += 1) {
      const startedAt = Date.now();
      const done = new Set<string>();
      try {
        const result = await runAgentTask({
          model,
          step: `${step}:${issues ? "fix" : "write"}:${splits}`,
          task,
          maxInputTokens: this.loopTokens,
          deadline: this.request.deadline,
          input: this.#batchInput(batch, evidenceTokens, issues),
          environment: this.#batchEnvironment(batch, done),
          signal: this.signal,
        });
        this.#logTask(task.name, result, startedAt);
        // Pages the task neither wrote nor skipped wait for a later refresh.
        const left = batch.pages.filter((page) => !done.has(page.path));
        if (left.length)
          skip(this.#expired() ? "deadline" : "unfinished", left);
        return;
      } catch (error) {
        // A step that stalled or ran away past its attempts would do so
        // again; its pages wait for a later refresh and the other batches
        // still publish.
        if (stalled(error) && !this.signal.aborted) {
          skip((error as ModelCallError).kind);
          return;
        }
        if (!tooLarge(error) || splits >= MAX_SPLITS) {
          if (!tooLarge(error) || this.signal.aborted) throw error;
          skip(error.kind);
          return;
        }
        if (evidenceTokens > MIN_EVIDENCE_TOKENS) {
          evidenceTokens = Math.max(
            MIN_EVIDENCE_TOKENS,
            Math.floor(evidenceTokens / 2),
          );
          continue;
        }
        if (batch.pages.length < 2) {
          skip(error.kind);
          return;
        }
        const half = Math.ceil(batch.pages.length / 2);
        await this.#writeBatch(
          model,
          this.#batch(batch.pages.slice(0, half)),
          `${step}a`,
          issues,
        );
        await this.#writeBatch(
          model,
          this.#batch(batch.pages.slice(half)),
          `${step}b`,
          issues,
        );
        return;
      }
    }
  }

  #batchInput(
    batch: PageBatch,
    evidenceTokens: number,
    issues?: ReadonlyMap<string, string>,
  ): string {
    const pages = batch.pages.map((page, index) => {
      const current = this.#current(page.path);
      const pageIssues = issues?.get(page.path);
      return `## ${index + 1}. ${page.todo.name}

Type: ${page.todo.type}
Path: ${page.path} (${page.existing ? "existing page" : "new page"}; object \`${pageObjectType(page)}\`)
${page.todo.notes.length ? `\nRouting notes:\n${page.todo.notes.map((note) => `- ${note}`).join("\n")}\n` : ""}${page.removedRefs?.length ? `\nDeleted sources: ${page.removedRefs.join(", ")}. Remove the facts that only they support: list each in \`removed_refs\` of every summary section that cites it, with the reason, and retract items that rest only on them.\n` : ""}${pageIssues ? `\nIssues to fix:\n${pageIssues}\n` : ""}
Related pages: ${page.related.length ? page.related.map((entry) => `${entry.path} (${entry.name})`).join("; ") : "none"}

Current page:

${current ?? "This page does not exist yet."}`;
    });
    return `# Pages

${pages.join("\n\n")}

# Evidence

${renderExcerpts(
  batch.sources,
  batch.refs,
  batch.pages.map((page) => page.todo.name),
  evidenceTokens,
)}`;
  }

  /** Checks and stages the batch's pages; reads sources and pages. */
  #batchEnvironment(batch: PageBatch, done: Set<string>): AgentEnvironment {
    const parts = new Map(
      batch.sources.map((source) => [
        source.id,
        sourceParts(source, LIMITS.batch.result * CHARS_PER_TOKEN),
      ]),
    );
    const byPath = new Map(batch.pages.map((page) => [page.path, page]));
    return {
      runTool: async (name, args) => {
        if (name === "read_source") return readSourcePart(parts, args);
        if (name === "read_page") return this.#readPage(String(args.path));
        if (name === "skip_page") {
          const path = String(args.path)
            .trim()
            .replace(/^\.?\/+/u, "");
          if (!byPath.has(path))
            return { ok: false, content: `${path} is not a page of this task` };
          done.add(path);
          return { ok: true, content: `skipped ${path}` };
        }
        return { ok: false, content: `Unknown tool ${name}` };
      },
      propose: async (object, proposed, payload) => {
        const target = proposed.trim().replace(/^\.?\/+/u, "");
        const page = byPath.get(target);
        if (!page)
          return {
            ok: false,
            content: `This task writes only ${[...byPath.keys()].join(", ")}`,
          };
        if (object !== pageObjectType(page))
          return {
            ok: false,
            content: `${target} is written as \`${pageObjectType(page)}\``,
          };
        const result = await this.#stagePage(
          page.path,
          page.definition,
          payload,
          this.#previous(page.path),
        );
        if (result.ok) done.add(page.path);
        return result;
      },
      unfinished: () => {
        const left = [...byPath.keys()].filter((path) => !done.has(path));
        return left.length
          ? `propose or skip_page ${left.join(", ")}`
          : undefined;
      },
    };
  }

  /** Renders, checks and writes one page into the candidate. */
  async #stagePage(
    path: string,
    definition: PersonalWikiNodeType,
    payload: Readonly<Record<string, unknown>>,
    previous: string | undefined,
  ): Promise<AgentObservation> {
    try {
      const markdown = renderWikiPage(
        path,
        wikiPageFromStrictPayload(definition, payload),
        this.references,
        previous,
      );
      const file = join(this.directory, path);
      await mkdir(dirname(file), { recursive: true });
      const content = (await degradeInvalidMermaidFences(markdown)).content;
      await writeFile(file, content);
      if (this.request.onPreviewPage) {
        // Final normalization and correction can still repair this page.
        let preview: string | null = content;
        try {
          validateWikiPageTemplate(path, content, this.references);
        } catch {
          preview = null;
        }
        this.request.onPreviewPage(path, preview);
      }
      return { ok: true, content: `accepted ${path}` };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async #readPage(path: string): Promise<AgentObservation> {
    if (!isWikiPageKey(path))
      return { ok: false, content: "Not a Wiki page path" };
    try {
      return {
        ok: true,
        content: wikiPageForModel(
          path,
          await readFile(join(this.directory, path), "utf8"),
          this.references,
        ),
      };
    } catch {
      return { ok: false, content: `${path} does not exist` };
    }
  }

  /**
   * Writes one meeting's Session page. A transcript longer than one task is
   * written in parts, in order: each part updates the page the earlier parts
   * wrote. A prompt that is still too large halves the parts.
   */
  async #writeMeeting(
    model: ModelChain,
    task: PageTask,
    issues?: string,
  ): Promise<void> {
    const agentTask = meetingTask(task.definition);
    this.#meetings.set(task.path, task);
    const meeting = task.sources[0]!;
    const skip = (reason: string) =>
      this.#unsettle("wiki_meeting_skipped", [meeting], {
        page: task.path,
        reason,
      });
    if (this.#expired()) {
      skip("deadline");
      return;
    }
    const previous = this.#previous(task.path);
    const published = this.#current(task.path);
    const limits = LIMITS.meeting;
    // The page grows part by part, up to what one reply writes.
    let evidenceTokens = Math.max(
      MIN_EVIDENCE_TOKENS,
      this.loopTokens -
        estimateTokens(agentTask.instructions) -
        estimateTokens(task.input("", issues)) -
        Math.max(estimateTokens(published ?? ""), limits.output) -
        limits.steps * (limits.output + limits.result),
    );
    for (let splits = 0; ; splits += 1) {
      const parts = splitSource(meeting, evidenceTokens);
      try {
        for (const [index, part] of parts.entries()) {
          const current =
            index === 0 ? published : await this.#stagedPage(task.path);
          const step = `meeting:${task.path}:${issues ? "fix" : "write"}:${splits}${parts.length > 1 ? `:${index + 1}` : ""}`;
          const startedAt = Date.now();
          const result = await runAgentTask({
            model,
            step,
            task: agentTask,
            maxInputTokens: this.loopTokens,
            deadline: this.request.deadline,
            input: `${task.input(meetingPart(meeting, part, index, parts.length), issues)}\n\n# Current page\n\n${current ?? "This page does not exist yet."}`,
            environment: this.#meetingEnvironment(task, previous),
            signal: this.signal,
          });
          this.#logTask(agentTask.name, result, startedAt);
          if (!result.finished && this.#expired()) {
            skip("deadline");
            return;
          }
        }
        return;
      } catch (error) {
        if (
          tooLarge(error) &&
          splits < MAX_SPLITS &&
          evidenceTokens > MIN_EVIDENCE_TOKENS
        ) {
          evidenceTokens = Math.max(
            MIN_EVIDENCE_TOKENS,
            Math.floor(evidenceTokens / 2),
          );
          continue;
        }
        // Like a skipped batch: the meeting waits for a later refresh and the
        // other sources still publish.
        if (!skippable(error) || this.signal.aborted) throw error;
        skip((error as ModelCallError).kind);
        return;
      }
    }
  }

  /** The page an earlier part of this run staged, as its writer sees it. */
  async #stagedPage(path: string): Promise<string | undefined> {
    const staged = await this.#readPage(path);
    return staged.ok ? staged.content : this.#current(path);
  }

  /** Validates the candidate, corrects the pages it rejects once, then
   * restores or omits what still fails. */
  async #finish(): Promise<number> {
    const validatedAt = Date.now();
    let issues = await this.#inspect();
    const owned = issues.filter(
      (issue) =>
        issue.page !== undefined &&
        (this.#meetings.has(issue.page) || this.#batchOf.has(issue.page)),
    );
    if (owned.length) {
      const byPage = new Map<string, string>();
      for (const issue of owned)
        byPage.set(
          issue.page!,
          `${byPage.get(issue.page!) ?? ""}- ${issue.code}: ${issue.detail}\n`,
        );
      wikiLogger().log("info", "wiki.generation_phase", {
        phase: "candidate_correction",
        issue_count: owned.length,
      });
      // Each rejected entity page is rewritten with the rest of its batch's
      // rejected pages, from the same evidence.
      const fixes = new Map<PageBatch, PagePlan[]>();
      for (const page of byPage.keys()) {
        const batch = this.#batchOf.get(page);
        if (!batch) continue;
        fixes.set(batch, [
          ...(fixes.get(batch) ?? []),
          batch.pages.find((plan) => plan.path === page)!,
        ]);
      }
      await this.#each(
        [...this.#meetings.keys()].filter((page) => byPage.has(page)),
        (page) => `meeting-fix:${page}`,
        (model, page) =>
          this.#writeMeeting(
            model,
            this.#meetings.get(page)!,
            byPage.get(page),
          ),
      );
      await this.#each(
        [...fixes.values()],
        (_pages, index) => `fix:${index + 1}`,
        (model, pages, step) =>
          this.#writeBatch(model, this.#batch(pages), step, byPage),
      );
      issues = await this.#inspect();
    }
    const meetings = this.#settledMeetings().map(
      (source) => source.input.session!.targetPath,
    );
    const repaired = new Set<string>();
    while (issues.length) {
      if (issues.some((issue) => issue.page && repaired.has(issue.page))) break;
      const recovery = await recoverOptionalWikiPages({
        directory: this.directory,
        baselineDirectory: this.request.existingOutputDirectory,
        baseline: this.baseline,
        requiredTargets: meetings,
        issues: keepOneDuplicate(issues, this.baseline),
      });
      if (!recovery) break;
      for (const page of [...recovery.restored, ...recovery.omitted])
        repaired.add(page);
      writeWikiLog("wiki_candidate_page_recovery", {
        run_id: this.runId,
        restored_pages: recovery.restored,
        omitted_pages: recovery.omitted,
      });
      // What this run wrote for these pages is gone; their sources wait for
      // a later refresh.
      const lost = [...recovery.restored, ...recovery.omitted].flatMap((page) =>
        this.#pageSources(page),
      );
      if (lost.length)
        this.#unsettle("wiki_pages_unsettled", lost, {
          pages: [...recovery.restored, ...recovery.omitted],
        });
      issues = await this.#inspect();
    }
    if (issues.length)
      writeWikiLog(
        "wiki_candidate_rejected",
        {
          run_id: this.runId,
          issues: issues.slice(0, 20).map(({ code, page, detail }) => ({
            code,
            page,
            detail: detail.slice(0, 300),
          })),
        },
        "ERROR",
      );
    const pageCount = assertValidWikiCandidate({
      issues,
      pageCount: [...(await checkpointTree(this.directory)).keys()].filter(
        (path) => path.endsWith(".md"),
      ).length,
    });
    try {
      await scanGeneratedWiki(this.directory);
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "Invalid Wiki publication tree";
      writeWikiLog(
        "wiki_candidate_rejected",
        {
          run_id: this.runId,
          issues: [
            { code: "invalid_publication", detail: detail.slice(0, 300) },
          ],
        },
        "ERROR",
      );
      throw new WikiCandidateValidationError([
        { code: "invalid_publication", detail },
      ]);
    }
    logGenerationStep("candidate_validation", validatedAt, {
      page_count: pageCount,
    });
    return pageCount;
  }

  /** The changed sources this run wrote a page from. */
  #pageSources(path: string): readonly EvidenceSource[] {
    const meeting = this.#meetings.get(path);
    if (meeting) return meeting.sources;
    const plan = this.#batchOf
      .get(path)
      ?.pages.find((candidate) => candidate.path === path);
    return plan ? this.#batch([plan]).sources : [];
  }

  /** Meetings whose Session page this run must publish; a skipped one may
   * be left out. */
  #settledMeetings(): EvidenceSource[] {
    return this.sources.filter(
      (source) =>
        source.kind === "meeting" &&
        !this.#unsettled.has(source.id) &&
        !this.#deferred.has(source.id),
    );
  }

  async #inspect(): Promise<WikiCandidateIssue[]> {
    const changes = this.request.changes;
    await removeOmittedPersonalPages(this.directory);
    await normalizeWikiCandidate(this.directory, {
      sourcePaths: [...changes.added, ...changes.modified].map(
        (input) => input.contentPath,
      ),
      sourceTitles: [...changes.added, ...changes.modified].map(
        (input) => input.title,
      ),
    });
    await normalizeChangedMemoryNodeMetadata(this.directory, this.baseline);
    await synchronizeWikiIndexes(this.directory);
    const issues: WikiCandidateIssue[] = [];
    for (const [path, digest] of await checkpointTree(this.directory)) {
      if (
        !path.endsWith(".md") ||
        isIndexPage(path) ||
        this.baseline.get(path) === digest
      )
        continue;
      try {
        validateWikiPageTemplate(
          path,
          await readFile(join(this.directory, path), "utf8"),
          this.references,
        );
      } catch (error) {
        issues.push({
          code: "invalid_node_structure",
          page: path,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const meetings = this.#settledMeetings();
    const removedUrls = new Set(
      changes.removed.map((source) => canonicalRawSourceUrl(source.sourceUrl)),
    );
    const inspection = await inspectWikiCandidate(this.directory, {
      contentBaseline: this.baseline,
      expectedTargetPaths: meetings.map(
        (meeting) => meeting.input.session!.targetPath,
      ),
      targetSourceUrls: new Map(
        meetings.map((meeting) => [
          meeting.input.session!.targetPath,
          meeting.input.session!.citations,
        ]),
      ),
      enforceRegisteredNodes: true,
      allowedSourceUrls: [...this.references.values()],
      newSourceUrls: [
        ...new Set(
          this.sources.flatMap((source) =>
            source.input.session
              ? source.input.session.citations
              : [canonicalRawSourceUrl(source.input.sourceUrl)],
          ),
        ),
      ],
      requiredSourceUrls: [...this.existingUrls.values()]
        .flat()
        .filter((url) => !removedUrls.has(url)),
      requireContentChange: meetings.length > 0,
      preserveBaselineContentPages: true,
      sourceNodeTypes: meetings.length ? ["session"] : [],
    });
    if (inspection.warnings?.length)
      writeWikiLog("wiki_candidate_quality_warning", {
        run_id: this.runId,
        warning_count: inspection.warnings.length,
        codes: inspection.warnings.map((issue) => issue.code),
      });
    return [...issues, ...inspection.issues];
  }

  /** Records routed entities; a new name that matches a page joins that page. */
  /**
   * Parallel routing tasks name new entities without seeing each other, so
   * one entity can arrive under two names. Before any page is written, one
   * call reads every new entity routed this run beside the existing pages and
   * merges each group that names one entity, the way OpenWiki settles its
   * whole page plan before writing. It reports how many entities it merged
   * away; a failed call leaves the routing as it is.
   */
  async #consolidate(): Promise<number> {
    const fresh = [...this.#todos.entries()].filter(([, todo]) => !todo.page);
    if (fresh.length < 2 || this.#expired()) return 0;
    const listing = fresh
      .map(
        ([, todo], index) =>
          `- [${index + 1}] ${todo.type} "${todo.name}" (slug ${todo.slug ?? "none"}, ${todo.refs.size} sources): ${(todo.notes[0] ?? "").replace(/\s+/gu, " ").slice(0, 240)}`,
      )
      .join("\n");
    const registry = renderEntityRegistry(
      this.entities.slice(0, MAX_CONSOLIDATION_PAGES),
    );
    const merged = new Set<number>();
    const startedAt = Date.now();
    try {
      const result = await this.#chain!("consolidate", (model) =>
        runAgentTask({
          model,
          step: "consolidate",
          task: consolidateTask(),
          maxInputTokens: this.loopTokens,
          deadline: this.request.deadline,
          input: `${registry}\n# New entities routed this run\n\n${listing}`,
          environment: {
            runTool: async (name, args) =>
              name === "merge_entities"
                ? this.#mergeEntities(args, fresh, merged)
                : { ok: false, content: `Unknown tool ${name}` },
            propose: async () => ({
              ok: false,
              content: "This task writes no pages.",
            }),
          },
          signal: this.signal,
        }),
      );
      this.#logTask("wiki.consolidate", result, startedAt);
    } catch (error) {
      if (this.signal.aborted) throw error;
      writeWikiLog(
        "wiki_consolidate_skipped",
        { run_id: this.runId, error: String(error) },
        "ERROR",
      );
    }
    return merged.size;
  }

  /** Merges listed new entities into one of them or into an existing page. */
  #mergeEntities(
    args: Readonly<Record<string, unknown>>,
    fresh: ReadonlyArray<readonly [string, EntityTodo]>,
    merged: Set<number>,
  ): AgentObservation {
    const indexes = Array.isArray(args.merge)
      ? args.merge.filter((value): value is number => Number.isInteger(value))
      : [];
    const keep = typeof args.keep === "number" ? args.keep : undefined;
    const page = typeof args.page === "string" ? args.page.trim() : "";
    const all = [...(keep === undefined ? [] : [keep]), ...indexes];
    if (!indexes.length || all.some((index) => !fresh[index - 1]))
      return { ok: false, content: "Name listed entities by their numbers" };
    const picked = all.map((index) => fresh[index - 1]!);
    if (
      all.some((index) => merged.has(index)) ||
      new Set(all).size !== all.length
    )
      return { ok: false, content: "An entity is merged only once" };
    const type = picked[0]![1].type;
    if (picked.some(([, todo]) => todo.type !== type))
      return { ok: false, content: "Only entities of one type merge" };
    let target: EntityTodo;
    if (page) {
      if (keep !== undefined)
        return { ok: false, content: "Give either `keep` or `page`" };
      const entry = this.entities.find((candidate) => candidate.path === page);
      if (!entry || entry.type !== type)
        return { ok: false, content: `${page} is not a listed ${type} page` };
      target = this.#todos.get(page) ?? {
        type,
        page,
        name: entry.name,
        slug: undefined,
        refs: new Set<string>(),
        notes: [],
      };
      this.#todos.set(page, target);
    } else {
      if (keep === undefined)
        return { ok: false, content: "Give `keep` or `page`" };
      target = fresh[keep - 1]![1];
    }
    for (const index of indexes) {
      const [key, todo] = fresh[index - 1]!;
      for (const ref of todo.refs) target.refs.add(ref);
      for (const note of todo.notes)
        if (!target.notes.includes(note)) target.notes.push(note);
      const alias = `Also named "${todo.name}" in the evidence; keep that name as an alias.`;
      if (todo.name !== target.name && !target.notes.includes(alias))
        target.notes.push(alias);
      this.#todos.delete(key);
      merged.add(index);
    }
    return {
      ok: true,
      content: `merged into ${page || `"${target.name}"`}`,
    };
  }

  #todoEnvironment(refs: ReadonlySet<string>): AgentEnvironment {
    return {
      runTool: async (name, args) => {
        if (name !== "add_todo")
          return { ok: false, content: `Unknown tool ${name}` };
        return this.#addTodo(args, refs);
      },
      propose: async () => ({
        ok: false,
        content: "This task writes no pages.",
      }),
    };
  }

  #addTodo(
    args: Readonly<Record<string, unknown>>,
    allowed: ReadonlySet<string>,
  ): AgentObservation {
    const type = args.type as EntityTypeId;
    const definition = PERSONAL_WIKI_NODE_TYPES.get(type);
    if (!definition || definition.kind !== "entity")
      return { ok: false, content: `Unknown entity type ${String(args.type)}` };
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return { ok: false, content: "`name` is required" };
    const refs = Array.isArray(args.refs)
      ? args.refs.filter((ref): ref is string => typeof ref === "string")
      : [];
    const unknown = refs.filter((ref) => !allowed.has(ref));
    if (!refs.length || unknown.length)
      return {
        ok: false,
        content: unknown.length
          ? `These refs are not in this evidence: ${unknown.join(", ")}`
          : "`refs` must cite the evidence that supports the entity",
      };
    let page = typeof args.page === "string" ? args.page.trim() : undefined;
    if (page) {
      const entry = this.entities.find((candidate) => candidate.path === page);
      if (!entry)
        return {
          ok: false,
          content: `${page} is not in the registry; use null for a new entity`,
        };
      if (entry.type !== type)
        return { ok: false, content: `${page} is a ${entry.type} page` };
    } else {
      page = this.#matchEntity(type, name);
    }
    const slug = typeof args.slug === "string" ? args.slug.trim() : undefined;
    if (!page && !(slug && /^[a-z0-9][a-z0-9-]{0,79}$/u.test(slug)))
      return {
        ok: false,
        content:
          "A new entity needs `slug`: lowercase ASCII letters, digits and hyphens",
      };
    const key = page ?? `${identityScope(type)}:${identityKey(name)}`;
    let todo = this.#todos.get(key);
    if (!todo && !page) {
      // Routing tasks that name one new entity differently ("AWS",
      // "Amazon Web Services") give it the same slug: it is one page, not two
      // duplicates that correction and recovery would both drop.
      todo = [...this.#todos.values()].find(
        (other) => !other.page && other.type === type && other.slug === slug,
      );
      const alias = `Also named "${name}" in the evidence; keep that name as an alias.`;
      if (todo && !todo.notes.includes(alias)) todo.notes.push(alias);
    }
    if (!todo) {
      todo = { type, page, name, slug, refs: new Set<string>(), notes: [] };
      this.#todos.set(key, todo);
    }
    for (const ref of refs) todo.refs.add(ref);
    if (typeof args.note === "string" && args.note.trim())
      todo.notes.push(args.note.trim());
    return {
      ok: true,
      content: page
        ? `routed to ${page}`
        : `routed to new ${type} "${todo.name}"`,
    };
  }

  /** An existing page whose name, alias or part is this name. */
  #matchEntity(type: EntityTypeId, name: string): string | undefined {
    const key = identityKey(name);
    if (key.length < 2) return undefined;
    const scope = identityScope(type);
    return this.entities.find(
      (entry) =>
        identityScope(entry.type as EntityTypeId) === scope &&
        [entry.name, ...entry.aliases, ...entry.parts].some(
          (identity) => identityKey(identity) === key,
        ),
    )?.path;
  }

  #newPagePath(todo: EntityTodo, taken: ReadonlySet<string>): string {
    const directory = PERSONAL_WIKI_NODE_TYPES.get(todo.type)!.directory;
    const base = todo.slug ?? "entity";
    for (let index = 1; ; index += 1) {
      const path = `${directory}/${index === 1 ? base : `${base}-${index}`}.md`;
      if (!taken.has(path) && !this.baseline.has(path) && isWikiPageKey(path))
        return path;
    }
  }

  /** Checks and stages the meeting's Session page and routes its entities. */
  #meetingEnvironment(
    task: PageTask,
    previous: string | undefined,
  ): AgentEnvironment {
    const parts = new Map(
      task.sources.map((source) => [
        source.id,
        sourceParts(source, LIMITS.meeting.result * CHARS_PER_TOKEN),
      ]),
    );
    const refs = new Set(task.sources.flatMap(sourceRefs));
    return {
      runTool: async (name, args) => {
        if (name === "read_source") return readSourcePart(parts, args);
        if (name === "read_page") return this.#readPage(String(args.path));
        if (name === "add_todo") return this.#addTodo(args, refs);
        return { ok: false, content: `Unknown tool ${name}` };
      },
      propose: async (_object, proposed, payload) => {
        const target = proposed.trim().replace(/^\.?\/+/u, "");
        if (target !== task.path)
          return { ok: false, content: `This task writes only ${task.path}` };
        return this.#stagePage(task.path, task.definition, payload, previous);
      },
    };
  }

  /** Submits one chain per item at once, named by step; the queue decides
   * how many run together. The first failure stops the rest. */
  async #each<T>(
    items: readonly T[],
    step: (item: T, index: number) => string,
    work: (model: ModelChain, item: T, step: string) => Promise<void>,
  ): Promise<void> {
    let failure: unknown;
    await Promise.all(
      items.map(async (item, index) => {
        try {
          this.signal.throwIfAborted();
          const name = step(item, index);
          await this.#chain!(name, (model) => work(model, item, name));
        } catch (error) {
          if (failure === undefined) {
            failure = error;
            this.#abort.abort();
          }
        }
      }),
    );
    if (failure === undefined) return;
    if (
      failure instanceof ActorAssetError ||
      failure instanceof WikiCandidateValidationError ||
      (this.request.signal?.aborted && failure instanceof Error)
    )
      throw failure;
    throw generationInvocationError(failure);
  }

  #logTask(
    task: string,
    result: Awaited<ReturnType<typeof runAgentTask>>,
    startedAt: number,
  ): void {
    wikiLogger().log("info", "wiki.agent_task", {
      run_id: this.runId,
      task,
      steps: result.steps.length,
      finished: result.finished,
      accepted: result.accepted,
      rejected: result.rejected,
      duration_ms: Date.now() - startedAt,
    });
  }
}

const ADD_TODO: AgentTool = {
  name: "add_todo",
  description:
    "Route one entity the evidence supports to its page (see add_todo above).",
  argumentsSchema: strictObject({
    type: {
      type: "string",
      enum: PERSONAL_WIKI_ENTITY_TYPES.map((definition) => definition.id),
    },
    page: { type: ["string", "null"] },
    name: { type: "string", minLength: 1, maxLength: 200 },
    slug: { type: ["string", "null"] },
    refs: { type: "array", items: { type: "string" } },
    note: { type: "string", maxLength: 600 },
  }),
};

const READ_SOURCE: AgentTool = {
  name: "read_source",
  description:
    "Read one part of a source shown under Evidence, by its id and part number, when an excerpt is not enough.",
  argumentsSchema: strictObject({
    source: { type: "string" },
    part: { type: "integer" },
  }),
};

const READ_PAGE: AgentTool = {
  name: "read_page",
  description: "Read another Wiki page, by its path, to link it correctly.",
  argumentsSchema: strictObject({ path: { type: "string" } }),
};

function routeTask(): AgentTask {
  return {
    name: "wiki.route",
    instructions: `${readPrompt("routing.md")}

# Entity identity rules

${personalWikiIdentityRules()}`,
    objects: [],
    tools: [ADD_TODO],
    maxSteps: LIMITS.route.steps,
    maxActions: LIMITS.route.actions,
    maxResultChars: LIMITS.route.result * CHARS_PER_TOKEN,
    effort: "medium",
    timeoutMs: STEP_TIMEOUT_MS,
    maxOutputChars: outputCapChars(LIMITS.route.output),
  };
}

const MERGE_ENTITIES: AgentTool = {
  name: "merge_entities",
  description:
    "Merge listed new entities that are one entity: into the listed new entity `keep`, or into the existing page `page`. Give the numbers to merge in `merge`.",
  argumentsSchema: strictObject({
    keep: { type: ["integer", "null"] },
    page: { type: ["string", "null"] },
    merge: { type: "array", items: { type: "integer" }, minItems: 1 },
    reason: { type: "string", maxLength: 300 },
  }),
};

/** Settles one name per entity across the run's parallel routing tasks. */
function consolidateTask(): AgentTask {
  return {
    name: "wiki.consolidate",
    instructions: `Settle the new entities of this Wiki update before their pages are written.

Several routing tasks read different parts of the evidence at the same time and each named the new entities it found, without seeing the others. One real-world entity may therefore be listed more than once under different names: another spelling, language, abbreviation or word order, or a more or less specific name for the same initiative. The existing pages are listed first.

- For each group of listed new entities that is one entity, call \`merge_entities\` once: \`keep\` is the number of the clearest name, \`merge\` the others. Their evidence and notes join it and the other names become aliases.
- When a new entity is an existing page's entity, merge it into that page with \`page\` instead of \`keep\`.
- Merge only the same entity. Related entities stay apart: a Project and the field it belongs to as a Topic, a company and a person who works there, two separate projects of one company, or two people with the same name. Entities of different types never merge.
- Decide from the names, types and notes shown. When nothing is listed twice, call no tool and finish.`,
    objects: [],
    tools: [MERGE_ENTITIES],
    maxSteps: LIMITS.consolidate.steps,
    maxActions: LIMITS.consolidate.actions,
    maxResultChars: LIMITS.consolidate.result * CHARS_PER_TOKEN,
    effort: "medium",
    timeoutMs: STEP_TIMEOUT_MS,
    maxOutputChars: outputCapChars(LIMITS.consolidate.output),
  };
}

function meetingTask(definition: PersonalWikiNodeType): AgentTask {
  return {
    name: "wiki.meeting",
    instructions: `Write the Session page of one meeting from its full transcript, and route every durable entity the meeting supports with \`add_todo\`, citing the transcript.

- Propose the Session page once, at the path and with the fields the task gives.
- Then route the meeting's entities as below; their pages are written later from the transcript.

${readPrompt("routing.md")}

# Entity identity rules

${personalWikiIdentityRules()}`,
    objects: [pageObject(definition)],
    tools: [ADD_TODO],
    maxSteps: LIMITS.meeting.steps,
    maxActions: LIMITS.meeting.actions,
    maxResultChars: LIMITS.meeting.result * CHARS_PER_TOKEN,
    effort: "medium",
    timeoutMs: STEP_TIMEOUT_MS,
    maxOutputChars: outputCapChars(LIMITS.meeting.output),
  };
}

const SKIP_PAGE: AgentTool = {
  name: "skip_page",
  description:
    "Leave one page of this task unwritten when its evidence supports nothing durable, with the reason.",
  argumentsSchema: strictObject({
    path: { type: "string" },
    reason: { type: "string", maxLength: 300 },
  }),
};

/** Writes several entity pages from the evidence routed to them. */
function batchTask(pages: readonly PagePlan[]): AgentTask {
  const objects = new Map<string, ReturnType<typeof pageObject>>();
  for (const page of pages) {
    const type = pageObjectType(page);
    if (objects.has(type)) continue;
    const sibling = page.existing ? `${type}.new` : type.slice(0, -4);
    objects.set(
      type,
      pageObject(
        page.definition,
        page.existing,
        objects.has(sibling)
          ? `The \`${sibling}\` rules apply; this object is for its ${page.existing ? "existing" : "new"} pages.`
          : undefined,
      ),
    );
  }
  return {
    name: "wiki.batch",
    instructions: `Write the durable Wiki pages this task names, each from the evidence routed to it.

- Pages lists each page with its type, path, canonical name and object. Propose each listed page once, with \`target\` set to its path and that object; never another page. Propose several pages in one step.
- An existing page is shown under Current page, without the parts the application writes (its source list and Change Log). Update it under the shared entity rules below: keep what the new evidence does not change, and change only what it supports.
- Write in the main language of the evidence messages; the routing notes are only pointers.
- On a new page write every summary section as \`{"text": ..., "reason": ...}\`; \`{"keep": true}\` only keeps text an existing page already has.
- The evidence shows the routed messages or passages with their citations. Use \`read_source\` when a passage needs more context, and \`read_page\` to check an existing related page before linking it. Pages marked new in this run are being written now: link them by path without reading them.
- Cite only \`raw:S…\` references shown in the evidence or already on the page.
- Link related pages with standard relative Markdown links, only to pages listed as related, pages of this task, or pages that exist.
- When the evidence turns out to support nothing durable about one page, \`skip_page\` it with the reason. The task finishes only when every page is accepted or skipped.

# Shared entity rules

${personalWikiEntityRules()}`,
    objects: [...objects.values()],
    tools: [READ_SOURCE, READ_PAGE, SKIP_PAGE],
    maxSteps: LIMITS.batch.steps,
    maxActions: LIMITS.batch.actions,
    maxResultChars: LIMITS.batch.result * CHARS_PER_TOKEN,
    effort: "medium",
    timeoutMs: STEP_TIMEOUT_MS,
    maxOutputChars: outputCapChars(pages.length * LIMITS.batch.output),
  };
}

/** Existing and new pages of a type are separate objects: a new page cannot keep text. */
function pageObjectType(page: PagePlan): string {
  return `wiki.${page.definition.id}${page.existing ? "" : ".new"}`;
}

/** Room a batch's loop keeps for one reply proposing every page and each step's results. */
function batchReserveTokens(pages: number): number {
  return pages * LIMITS.batch.output + LIMITS.batch.steps * LIMITS.batch.result;
}

function pageObject(
  definition: PersonalWikiNodeType,
  existing = false,
  instructions?: string,
) {
  return {
    type: `wiki.${definition.id}${existing || definition.kind !== "entity" ? "" : ".new"}`,
    instructions:
      instructions ?? formatPersonalWikiNodeTypeInstruction(definition),
    payloadSchema: strictWikiPageSchema(definition, { existing }),
  };
}

/** One part of a source shown under Evidence, for `read_source`. */
function readSourcePart(
  parts: ReadonlyMap<string, readonly string[]>,
  args: Readonly<Record<string, unknown>>,
): AgentObservation {
  const sourceParts = parts.get(String(args.source));
  const part = Number(args.part);
  if (!sourceParts)
    return {
      ok: false,
      content: `Unknown source; read one of: ${[...parts.keys()].join(", ")}`,
    };
  if (!Number.isInteger(part) || part < 1 || part > sourceParts.length)
    return {
      ok: false,
      content: `Parts of ${String(args.source)} are 1 to ${sourceParts.length}`,
    };
  return { ok: true, content: sourceParts[part - 1]! };
}

/**
 * At most MAX_CANDIDATES existing entities for some evidence: those whose
 * name, alias or part the evidence spells out, then the best BM25 matches of
 * the evidence against each entity's registry line, then the most recently
 * updated. A Wiki with no more entities than that is shown whole.
 */
function candidateEntities(
  entities: readonly WikiEntityEntry[],
  evidence: string,
): WikiEntityEntry[] {
  if (entities.length <= MAX_CANDIDATES) return [...entities];
  const text = identityKey(evidence);
  const named = entities.filter((entry) =>
    [entry.name, ...entry.aliases, ...entry.parts].some((identity) => {
      const key = identityKey(identity);
      return key.length >= 2 && text.includes(key);
    }),
  );
  const matched = searchBm25(
    entities.map((entry) => ({
      value: entry,
      text: [entry.name, ...entry.aliases, ...entry.parts, entry.description]
        .filter(Boolean)
        .join(" "),
    })),
    evidence,
  ).map((result) => result.value);
  const recent = [...entities].sort((left, right) =>
    (right.updated ?? "").localeCompare(left.updated ?? ""),
  );
  return [...new Set([...named, ...matched, ...recent])].slice(
    0,
    MAX_CANDIDATES,
  );
}

/** Projects and Topics share one identity space; other types their own. */
function identityScope(type: EntityTypeId): string {
  return type === "project" || type === "topic" ? "initiative" : type;
}

/**
 * New pages of this run that still name one entity after correction: recovery
 * omits all but the first by path, which then names it alone. Otherwise each
 * page's duplicate issue would omit both and the entity would have no page.
 */
function keepOneDuplicate(
  issues: readonly WikiCandidateIssue[],
  baseline: ReadonlyMap<string, string>,
): WikiCandidateIssue[] {
  const duplicate = (issue: WikiCandidateIssue) =>
    issue.code === "duplicate_entity_identity" &&
    issue.page !== undefined &&
    !baseline.has(issue.page);
  const flagged = new Set(issues.filter(duplicate).map((issue) => issue.page));
  return issues.filter(
    (issue) =>
      !duplicate(issue) ||
      !issue.relatedPages?.length ||
      !issue.relatedPages.every(
        (other) => flagged.has(other) && issue.page! < other,
      ),
  );
}

function tooLarge(error: unknown): error is ModelCallError {
  return error instanceof ModelCallError && error.kind === "invalid_request";
}

/** A step that timed out or passed its output cap past its kind's attempts. */
function stalled(error: unknown): boolean {
  return (
    error instanceof ModelCallError &&
    (error.kind === "timed_out" || error.kind === "output_limited")
  );
}

/** A task failure that would repeat for the same input: it skips its sources
 * rather than failing the refresh. An offline Computer is not one. */
function skippable(error: unknown): boolean {
  return stalled(error) || tooLarge(error);
}

/** A changed source's text, cut into the units tasks cite and excerpt. */
async function readEvidence(
  inputsDirectory: string,
  input: WikiInput,
): Promise<EvidenceSource> {
  const markdown = await readFile(
    join(inputsDirectory, input.contentPath),
    "utf8",
  );
  if (!input.session) {
    const ref = rawSourceReference(input.sourceUrl);
    return {
      id: input.assetKey,
      title: input.title,
      kind: "document",
      date: undefined,
      human: undefined,
      input,
      units: paragraphs(markdown).map((text) => ({ refs: [ref], text })),
    };
  }
  const header = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  const fields: unknown = header ? parseYaml(header[1]!) : undefined;
  const identity =
    isRecord(fields) && isRecord(fields.session_identity)
      ? fields.session_identity
      : {};
  const body = markdown
    .slice(header?.[0].length ?? 0)
    .replace(/^Message metadata: .*$\n?/gmu, "");
  const chat = input.session.citations.every((url) =>
    url.startsWith("teamhub://rooms/"),
  );
  const base = {
    id: input.assetKey,
    title: input.title,
    date: input.session.date,
    human:
      typeof identity.represented_human_display_name === "string"
        ? identity.represented_human_display_name
        : undefined,
    input,
  };
  if (!chat) {
    const ref = rawSourceReference(input.session.citations[0]!);
    return {
      ...base,
      kind: "meeting",
      units: paragraphs(body.replace(/^Citation: .*$\n?/gmu, "")).map(
        (text) => ({ refs: [ref], text }),
      ),
    };
  }
  const units = body
    .split(/^(?=## )/mu)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({
      refs: [...text.matchAll(/\[\[source:(raw:S[0-9a-f]+)\]\]/gu)].map(
        (match) => match[1]!,
      ),
      text,
    }));
  return { ...base, kind: "chat", units };
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function sourceRefs(source: EvidenceSource): string[] {
  return [...new Set(source.units.flatMap((unit) => unit.refs))];
}

function sourceHeader(source: EvidenceSource, part?: string): string {
  const attributes = [
    `id="${source.id}"`,
    `kind="${source.kind}"`,
    ...(source.date ? [`date="${source.date}"`] : []),
    ...(source.human ? [`human="${escapeAttribute(source.human)}"`] : []),
    `title="${escapeAttribute(source.title)}"`,
    ...(part ? [`part="${part}"`] : []),
  ];
  return `<source ${attributes.join(" ")}>`;
}

/** A source in full; Documents and meetings name their citation once. */
function renderSource(source: EvidenceSource): string {
  return `${sourceHeader(source)}\n${renderUnits(source, source.units)}\n</source>`;
}

function renderUnits(
  source: EvidenceSource,
  units: readonly EvidenceUnit[],
): string {
  return source.kind === "chat"
    ? units.map((unit) => unit.text).join("\n\n")
    : `Citation: [[source:${units[0]?.refs[0] ?? ""}]]\n\n${units.map((unit) => unit.text).join("\n\n")}`;
}

/** The source cut into parts of at most `maxChars` characters, for `read_source`. */
function sourceParts(source: EvidenceSource, maxChars: number): string[] {
  const parts: EvidenceUnit[][] = [[]];
  let size = 0;
  for (const unit of source.units) {
    if (size > 0 && size + unit.text.length > maxChars) {
      parts.push([]);
      size = 0;
    }
    parts.at(-1)!.push(unit);
    size += unit.text.length;
  }
  return parts.map(
    (units, index) =>
      `${sourceHeader(source, `${index + 1} of ${parts.length}`)}\n${renderUnits(source, units)}\n</source>`,
  );
}

/**
 * Packs sources for routing within `tokens` each, in date order. A source
 * larger than a pack is cut at message or paragraph boundaries.
 */
function packEvidence(
  sources: readonly EvidenceSource[],
  tokens: number,
): EvidenceSource[][] {
  const pieces = [...sources]
    .sort(
      (left, right) =>
        (left.date ?? "").localeCompare(right.date ?? "") ||
        left.title.localeCompare(right.title),
    )
    .flatMap((source) => splitSource(source, tokens));
  const packs: EvidenceSource[][] = [];
  let size = 0;
  for (const piece of pieces) {
    const pieceTokens = estimateTokens(renderSource(piece));
    if (packs.length === 0 || size + pieceTokens > tokens) {
      packs.push([]);
      size = 0;
    }
    packs.at(-1)!.push(piece);
    size += pieceTokens;
  }
  return packs;
}

/** The source in consecutive pieces of at most `tokens`, cut at message or
 * paragraph boundaries; one unit larger than that stays whole. */
function splitSource(source: EvidenceSource, tokens: number): EvidenceSource[] {
  const pieces: EvidenceSource[] = [];
  let units: EvidenceUnit[] = [];
  let size = 0;
  for (const unit of source.units) {
    const unitTokens = estimateTokens(unit.text);
    if (units.length && size + unitTokens > tokens) {
      pieces.push({ ...source, units });
      units = [];
      size = 0;
    }
    units.push(unit);
    size += unitTokens;
  }
  if (units.length) pieces.push({ ...source, units });
  return pieces;
}

/** The transcript a meeting task reads: whole, or one part with what to do with it. */
function meetingPart(
  meeting: EvidenceSource,
  part: EvidenceSource,
  index: number,
  count: number,
): string {
  if (count === 1) return renderSource(meeting);
  const note =
    index === 0
      ? `The transcript is long, so it comes in ${count} parts, in order. This is part 1: write the page from it; later parts update it.`
      : `This is part ${index + 1} of ${count} of the transcript, in order. The current page holds what the earlier parts established: keep it, add and correct what this part says, and propose the whole page again. Route the entities this part supports.`;
  return `${note}\n\n${sourceHeader(meeting, `${index + 1} of ${count}`)}\n${renderUnits(meeting, part.units)}\n</source>`;
}

/**
 * The evidence of some entities within `tokens`: the routed chat messages
 * with their neighbors, and the passages of Documents and meetings that name
 * an entity, or the whole source when it fits.
 */
function renderExcerpts(
  sources: readonly EvidenceSource[],
  refs: ReadonlySet<string>,
  names: readonly string[],
  tokens: number,
): string {
  if (sources.length === 0) return "No new evidence; see Deleted sources.";
  const budget = tokens * CHARS_PER_TOKEN;
  const share = Math.floor(budget / sources.length);
  const nameKeys = names
    .map((name) => identityKey(name))
    .filter((key) => key.length >= 2);
  return sources
    .map((source) => {
      const whole = renderSource(source);
      if (whole.length <= share) return whole;
      const keep = new Set<number>();
      source.units.forEach((unit, index) => {
        const routed =
          source.kind === "chat"
            ? unit.refs.some((ref) => refs.has(ref))
            : nameKeys.some((key) => identityKey(unit.text).includes(key));
        if (!routed) return;
        for (const near of [index - 1, index, index + 1])
          if (near >= 0 && near < source.units.length) keep.add(near);
      });
      const chosen: EvidenceUnit[] = [];
      let size = 0;
      for (const index of [...keep].sort((left, right) => left - right)) {
        const unit = source.units[index]!;
        if (size + unit.text.length > share) break;
        if (chosen.length && !keep.has(index - 1))
          chosen.push({ refs: [], text: "…" });
        chosen.push(unit);
        size += unit.text.length;
      }
      if (chosen.length === 0)
        for (const unit of source.units) {
          if (size + unit.text.length > share) break;
          chosen.push(unit);
          size += unit.text.length;
        }
      const parts = sourceParts(
        source,
        LIMITS.batch.result * CHARS_PER_TOKEN,
      ).length;
      return `${sourceHeader(source, `excerpt; read_source parts 1 to ${parts} for the rest`)}\n${renderUnits(source, chosen)}\n</source>`;
    })
    .join("\n\n");
}

function escapeAttribute(value: string): string {
  return value.replace(/[\p{Cc}"<>]/gu, " ").trim();
}

function readPrompt(filename: string): string {
  return readFileSync(
    join(promptsRoot, "llm-wiki", "personal", filename),
    "utf8",
  ).trim();
}

/** A batch checkpoint resumes only under the prompts that wrote it. */
function agentWikiGenerationKey(): string {
  const hash = createHash("sha256").update("agent-wiki/1");
  for (const folder of ["llm-wiki", "memory-agent"]) {
    const prompts = join(promptsRoot, folder);
    for (const file of readdirSync(prompts, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort()) {
      hash
        .update(`\0${folder}/${relative(prompts, file)}\0`)
        .update(readFileSync(file));
    }
  }
  return hash.digest("hex");
}
