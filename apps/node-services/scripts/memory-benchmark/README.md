# Memory benchmark and full-flow test

Two tools live here, and both call the Memory and Wiki code of the current checkout directly:

- **Full-flow test (`lifecycle.ts`)**: a small dataset with known answers, run from the Profile and files of the connection day through two days of daytime and nightly work, checking every step, and ending with Another Me answering questions. About 4 minutes. Run it first after changing any part of Memory or Wiki.
- **Quality benchmark (`run.ts`)**: answer accuracy on public long-term memory datasets (LoCoMo, LongMemEval), compared with the results before a change to catch regressions.

## What it covers

```
scripts/memory-benchmark/
  lifecycle.ts          full-flow test entry: runs and checks each stage, then answers and judges
  lifecycle-fixture.ts  full-flow test data: Profile, connected files, two days of chats, a meeting, Pocket Notes and questions
  run.ts        benchmark entry: prepare history → answer → judge → report.md / summary.json
  datasets.ts   downloads LoCoMo / LongMemEval-S (pinned versions, SHA-256 checked) into one Case shape
  plans/        question lists (question IDs only)
  sessions.ts   one conversation = one Room-day, in the shape of TeamHub's Sessionly collection
  product.ts    the benchmark's product boundary: storage, indexing, nightly Wiki and the day read
  knowledge.ts  shared by both: Memory indexes on a throwaway database, Wiki generation, publishing into the index, search and read, bounded retries
  answer.ts     how Another Me answers: memory.md + Personal Knowledge policy + a knowledge search/read tool loop
  judge.ts      judging prompts (AMB + LongMemEval abstention questions), calibrated on known answers before a run
```

## Full-flow test (lifecycle)

Three days of one Human (Mira Chen). Each stage calls the product functions in the product's order and is checked right away:

| Stage                     | What it does                                                                                                                                                                                                  | What it checks                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day 0 (10-31, connection) | Indexes the Profile and writes the first memory.md (`syncProfileMemory`); indexes two My pages files and one mail, and initializes the Wiki                                                                   | memory.md comes from this Profile; the Wiki has project, client and contact pages citing the three files; the mail can be searched                                                                                                                                                                |
| Day 1 daytime (11-01)     | Archives and indexes the chats of two Rooms and one meeting recording, and extracts facts; the meeting triggers its own Wiki refresh                                                                          | the day's chats are searchable before the night; the meeting has a Session page and entity pages; this refresh leaves the chats alone                                                                                                                                                             |
| Night 1                   | The Wiki takes in the day's chats; the day read writes memory.md and the Daily (with the day's Pocket Note); Tracking Items; the next day is Monday, so last week's Weekly                                    | chats reach entity pages but get no chat Session page; the Daily cites both Rooms, the meeting and the Pocket Note and says there is no yesterday to compare; memory.md records "status updates as bullet points"; a to-do "send the revised SOW by Wednesday" exists; the Weekly cites the Daily |
| Day 2 and Night 2 (11-02) | The Atlas file gets a new version (budget 180,000 → 210,000); in chat the SOW is signed, and the preference changes to "two short paragraphs, no bullet points"                                               | the Wiki cites the new file version and says 210,000; the second Daily compares with yesterday; memory.md replaces the old preference with the new one; the SOW to-do closes                                                                                                                      |
| Answers (11-03 09:00)     | Another Me (memory.md + search) answers 11 questions covering the Profile, files, mail, a file update, a rescheduled chat, the meeting, the Pocket Note, a memory.md preference and one unanswerable question | a judge model marks each answer right or wrong                                                                                                                                                                                                                                                    |

Any failed check exits with 1. `<out>/` keeps:

- `report.md`: the result and evidence of every check, and every answer.
- `summary.json`: the check results, each step's duration and attempts, and model usage.
- `model-calls.jsonl`: the input and output of every model call, to see why a step did what it did.
- `wiki/<n>-<label>/`: the Wiki after each publication.
- `memory.md`, `tracking.json`: the final memory.md and to-dos.

```bash
node --env-file=../../.env --import tsx scripts/memory-benchmark/lifecycle.ts --out .local/memory-benchmark/lifecycle/<name> --database-url postgresql://postgres@127.0.0.1:54420/memory_benchmark
```

Use a new `--out` every time. The database is prepared as for the benchmark below, and one database can be reused.

Not covered: TeamHub source admission (the whitelist), publication and refresh queueing, the Memory scheduler's timing, retries and offline waiting, the Runtime on the Computer, the Web pages, and proactive dreaming. Check those in a real environment.

Content checks (for example whether memory.md recorded a preference) depend on model output and fail now and then. When one fails, read `model-calls.jsonl` first and decide whether it is a product problem; do not just run it again. Once, for example, the second night's Wiki routing gave no to-do at all and so missed the file change and the SOW signing.

## What the benchmark prepares

`product.ts` prepares each history in the product's order:

| Stage                                                                                               | Product code                                                                  |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Daytime: Room messages → Session Evidence and Raw sources                                           | `stageSessionRawForWiki`                                                      |
| Daytime: Raw chunk index (PostgreSQL keyword search) and Session fact extraction                    | `MemoryChunkIndex`, `SessionFactIndex`                                        |
| Nightly: updates the Wiki with the day's Room-days, keeping the previous one on failure             | `AgentWikiBackend.generate`, with input from `renderSessionSource`            |
| Nightly: the day read writes memory.md and the Daily from the day's raw conversations               | `collectAndPersistDaily` + `runDayRead`                                       |
| Publishing: the last Wiki pages and every Daily go into one index                                   | `wikiPageRawSource`, `periodReportSource`, `searchableWikiPage`               |
| Answers: the handlers behind `teamhub knowledge search/read`, and the memory.md Another Me receives | `queryPersonalKnowledge`, `readPersonalKnowledgeEvidence`, `renderUserMemory` |

Not run: Weekly and Tracking Items (neither affects answer retrieval here), and Pocket Notes and the Profile (the datasets have none).

Each nightly step is tried at most twice; when it still fails, that night is skipped: the Wiki keeps its previous version, memory.md stays unchanged, and the report counts the failure. Each night ends with a checkpoint (`state/memory/prepared/<corpus>.nightly/checkpoint.json`), so a run interrupted and started again with the same arguments continues from the next night.

## Arms (`--arms`)

- `product` (default): what Another Me actually gets. The system prompt is memory.md (rendered as the Agent's `user-memory` feature renders it) plus `PERSONAL_KNOWLEDGE_POLICY`, with the `knowledge_search` / `knowledge_read` tools over every source: Raw, Session facts, Wiki pages and Daily reports.
- `search`: the same search without memory.md. Compare it with `product` to see whether memory.md helps.
- `wiki`: only Wiki pages and Daily reports. Another search scope of the same Human holds only these two kinds, so Raw does not affect ranking.
- `memory-md`: memory.md only, no search.
- `none`: no memory, only the question. This is the floor that shows the questions and judging themselves are sound.

`--skip-nightly` runs only the daytime stages and prepares in a few minutes; then only `search` and `none` can run. A prepared history records which stages ran, so change `--state` when changing these arguments.

## Setup

1. A throwaway PostgreSQL on localhost whose database name starts with `memory_benchmark`, initialized with the TeamHub migrations:

   ```bash
   docker run -d --name memory-benchmark-postgres -p 127.0.0.1:54420:5432 \
     -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=memory_benchmark \
     pgvector/pgvector:0.8.6-pg17-bookworm
   ```

   ```bash
   cd apps/teamhub && TEAMHUB_DATABASE_URL='postgresql://postgres@127.0.0.1:54420/memory_benchmark?sslmode=disable' go run ./cmd/migrate
   ```

2. The root `.env` needs `TEAMHUB_ONBOARDING_LLM_GATEWAY_URL` and `TEAMHUB_ONBOARDING_LLM_GATEWAY_API_KEY`. Extraction, answering and judging all go through this gateway.
3. The datasets download on the first run into `apps/node-services/.local/memory-benchmark/data/`. LongMemEval-S is about 277 MB.

## Running

From `apps/node-services`:

```bash
node --env-file=../../.env --import tsx scripts/memory-benchmark/run.ts --plan locomo-validate7 --out .local/memory-benchmark/runs/locomo7 --database-url postgresql://postgres@127.0.0.1:54420/memory_benchmark --arms product,search,wiki,memory-md,none
```

Common options:

- `--plan`: `locomo-validate7` (7 questions, one history of 19 nights, about 25 minutes of nightly preparation, for smoke runs; about 1–2 minutes with `--skip-nightly`), `longmemeval-validate3` (3 questions), `locomo-amb120` (120 questions), `longmemeval-third60` (60 questions).
- `--rounds 3`: answer and judge the same prepared history 3 times.
- `--state <directory>`: reuse the history another run prepared (for example when only the answering model changes). Defaults to `<out>/state`.
- `--baseline <another out>`: add a comparison with that baseline to the report.
- `--retry-errors`: run the questions that failed before again. Each question retries a gateway call at most 3 times, then records an error and moves on instead of hanging.
- `--nightly-concurrency 4`: histories replayed night by night at once. LongMemEval has one history per question, so raise it; LoCoMo maps many questions onto one history.
- `--limit N`, `--concurrency 8`, `--model`, `--judge-model`: answering and judging default to `openai/gpt-5.6-luna`.

An interrupted run continues when started again with the same arguments: finished answers are kept under `<out>/answers/<arm>/r<round>/` and are not requested again.

## Reading the results

- `report.md`: each arm's accuracy per round, the mean, the min to max, failures, tool calls and time per question, and accuracy by question type.
- `summary.json`: the same data, plus preparation statistics (nights, failures, Wiki pages, Daily reports) and model usage (`preparation` covers storage, extraction and nights, `judge` covers judging; answering usage is in each question).
- `manifest.json`: the question list, models, judging protocol, and the checkout's commit and a hash of its uncommitted changes.
- Each question's JSON has the full tool-call record and the judge's reasoning, to investigate question by question.

To call a regression, run each arm at least 3 rounds and check whether the difference of the means is outside the baseline's own min-to-max range. Results vary a fair amount: with LoCoMo amb120 and only the Wiki, the same arm can differ by ±5 questions between rounds.

## Differences from production

- **The answering model's tools are not the CLI itself.** In production the Agent runs `teamhub knowledge search/read` through a shell in its Runtime; here the two commands are function tools that call Memory's handlers directly, with no TeamHub authorization chain and no CLI output projection.
- **Model calls go through an LLM gateway.** In production they run on the owner's Computer Runtime. Measure cost and time on the Runtime separately; `scripts/night-benchmark.ts` replays the nightly flow with local Codex or Claude Code and records each step's usage.
- **The Wiki updates once a day.** In production it refreshes after each Room goes quiet, possibly several times a day; here each dataset date updates once with all of that day's Room-days. A page's publication date is the last night it changed.
- **memory.md starts empty.** In production it starts from the Profile; the datasets have no Profile, so the first night's day read starts from an empty memory.md.
- **Identity mapping:** LongMemEval's user is the owner and its assistant is Another Me; LoCoMo's first speaker is the owner. Each conversation falls on the dataset's date in Asia/Shanghai local time.
- **Judging:** LoCoMo leaves out category 5 (adversarial questions), as the AMB protocol requires.
- **Database:** a prepared history belongs to its database; use another `--state` for another database.

## When the Memory / Wiki flow changes

- **Full-flow test:** replace the matching stage in `lifecycle.ts` with the new calls and add checks; add the data the new behavior needs to `lifecycle-fixture.ts`. Shared indexing, publishing and search live in `knowledge.ts`.
- **Benchmark:** change only `product.ts`: switch `prepare` to the new storage or nightly flow, update `productStages`, and add an arm in `answer.ts` if needed. Question lists, data, answering and judging stay as they are, so old and new results compare directly.
