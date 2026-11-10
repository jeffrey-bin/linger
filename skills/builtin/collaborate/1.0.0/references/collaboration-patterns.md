# Collaboration Patterns

Five patterns are accepted. Pick the one that matches how work actually moves between Agents, not
the one that sounds most thorough. A wrong pattern is worse than a plain description because every
member reads it as the plan.

## `classify-and-act`

One Agent decides which category the input belongs to; exactly one specialist then handles it.

```text
Router --> (Billing | Technical | Account)
```

Topology: each specialist has `Receive from: Router` and `Report to: Router`. Specialists do not
receive from each other.

Use it when: inputs are heterogeneous, and handling differs by kind.
Do not use it when: every input needs all specialists — that is `fan-out-and-synthesize`.

## `fan-out-and-synthesize`

Independent subtasks run in parallel, then one Agent merges them into a single result.

```text
Coordinator --> (Researcher, Analyst) --> Synthesizer
```

Topology: workers have `Receive from: Coordinator`; the synthesizer has `Receive from` listing
every worker it merges.

Use it when: subtasks do not depend on each other and the value is in combining them.
Do not use it when: one worker needs another's output first — declare that in `Receive from` and
accept that the work is sequential.

## `adversarial-verification`

A producer creates the work; an independent verifier tries to break it before it ships.

```text
Producer --> Verifier --> Coordinator
```

Topology: the verifier has `Receive from: Producer`. Keep them separate Agents; the point is
independence.

Use it when: a wrong result is expensive and mistakes are hard to see from the inside.
Do not use it when: the verifier would only restate the producer's reasoning.

State what the verifier checks against. A verifier with no standard produces agreement, not
verification.

## `tournament`

Several Agents attempt the same task; one selects the best result.

```text
(Candidate A, Candidate B, Candidate C) --> Judge
```

Topology: candidates all have `Receive from: Coordinator`; the judge has `Receive from` listing
every candidate.

Use it when: quality varies by approach and the best attempt is worth the duplicated cost.
Do not use it when: the task has one correct answer — you are paying N times for one result.

Say in the judge's `Role` what it selects on. Without stated criteria the selection is arbitrary.

## `loop-until-done`

Produce and review repeat until a quality bar is met.

```text
Writer <--> Reviewer   (until the bar is met)
```

Topology: `Writer` has `Receive from: Reviewer` and `Reviewer` has `Receive from: Writer`. This is
the one pattern where a mutual relationship is correct.

Use it when: the result improves through revision and "good enough" is recognizable.
Do not use it when: nobody can state the exit condition. Put the bar in the reviewer's `Role`, and
say who decides the loop is finished.

## Anti-patterns

- **Naming everyone in the Room.** A member with no distinct responsibility adds coordination cost
  and nothing else. Declare the Agents the work needs.
- **A topology that contradicts the pattern.** Declaring `fan-out-and-synthesize` and then chaining
  every worker to the previous one describes a sequence. Change one or the other.
- **Relationships with no `Role`.** `Report to` says where output goes; it does not say what the
  member owns. A reader cannot act on arrows alone.
- **Treating the topology as enforcement.** TeamHub does not block messages that ignore
  `Report to` / `Receive from`. The document coordinates; it does not constrain.
- **Republishing to make a small change.** Each publish replaces the whole document and bumps
  `revision`. That is fine when the plan really changed; it is noise when it did not.
