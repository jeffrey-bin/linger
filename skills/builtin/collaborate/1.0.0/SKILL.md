---
name: collaborate
description: Design a multi-Agent collaboration and publish it as this Room's team.md protocol document. Use when work needs more than one Agent and you must decide the collaboration pattern, who orchestrates, who reports to whom, and who hands off to whom.
---

# Collaborate through team.md

Turn a multi-Agent goal into one explicit protocol document. `teamhub room collaborate` publishes it as this
Room's `team.md` protocol and notifies every declared participant except the publishing Agent, including
a separately appointed Orchestrator. Members read the current protocol with
`teamhub room protocol`; no local team.md projection is mounted.

Read [Collaboration Patterns](references/collaboration-patterns.md) before choosing a pattern.

## 1. Confirm teamMD is the right tool

Publish a team.md only when all of these are true:

- the work genuinely needs more than one Agent;
- every Agent you intend to name is already a member of this Room;
- you can state one shared goal and each member's responsibility.

Do the work yourself when a single Agent suffices. Follow your Context's permissions for other
coordination tools; this Skill does not authorize creating a Task or Workflow.

If an Agent you need is not in the Room, add it first. `teamhub room collaborate` rejects the whole document
when any declared Actor is not an active Room member; it does not add anyone.

## 2. Choose one pattern

| Pattern | Use when |
| --- | --- |
| `classify-and-act` | Input must be routed to the one specialist that handles its category. |
| `fan-out-and-synthesize` | Independent subtasks run in parallel and one Agent merges the results. |
| `adversarial-verification` | A producer's output needs an independent challenger before it ships. |
| `tournament` | Several Agents attempt the same task and the best result is selected. |
| `loop-until-done` | Work repeats produce-then-review until a quality bar is met. |

The value must match one of these exactly. TeamHub does not normalize spelling, spacing, or case.

## 3. Choose the Orchestrator and write the document

Assess the capabilities of the Agents already in this Room and choose one suited to coordinating
the user's request. You may publish the plan with another Agent as Orchestrator and yourself as a
Team Member. If no other Agent is suited to orchestrate, act as both Orchestrator and contributor.
Describe your coordination and concrete work responsibilities in the Orchestrator's `Role`;
declare your Actor ID only once, without repeating yourself under Team Member.

```markdown
---
collaborate_pattern: fan-out-and-synthesize
---

## Task Goal

Summarize the competitive landscape for workflow platforms.

## Orchestrator

- Coordinator
  - ID: actor_agent_01

## Team Member

- Researcher
  - ID: actor_agent_02
  - Role: Collect raw vendor material.
  - Report to: Coordinator
  - Receive from: Coordinator

- Synthesizer
  - ID: actor_agent_03
  - Role: Merge findings into one brief.
  - Report to: Coordinator
  - Receive from: Researcher
```

Rules the document must satisfy:

- the frontmatter holds exactly one key, `collaborate_pattern`, with a value from the table above;
- `## Task Goal` is present and non-empty;
- `## Orchestrator` names exactly one suitable Room Agent, with an `ID`; it may be you or another Agent;
- `## Team Member` names at least one Agent; every name and every `ID` is unique;
- every `ID` is an Actor ID of an active member of this Room, not a display name;
- `Report to` and `Receive from` reference names declared in this same document, or `none`.
  Separate several names with commas;
- `Role` is optional but makes the protocol usable; write what that member owns, not how it works.

Name each participant with a short role-like name (`Researcher`, `Reviewer`). Relationships
reference these names, not Actor IDs.

## 4. Publish and hand off

Save the complete document to a UTF-8 file and run `teamhub room collaborate --file <plan-path> --operation-id <unique-plan-id> --json`. It publishes in the configured Room. No source Message ID is required; publication is a Room collaboration event. On success it returns `created: true`, `room_id`,
`revision`, and `notified_actor_ids` — the declared participants TeamHub notified. The
publishing Agent is excluded. A separately appointed Orchestrator is included and takes over
coordination; follow its assignments while completing your own contributor responsibilities.

Read current participants with `teamhub room members`; use its real Actor IDs.
Publishing replaces any previous `team.md` for this Room and bumps `revision`. There is no partial
update: send the whole document every time.

Publishing notifies the declared participants to read the protocol. Entry Agents can begin work
whose inputs are ready; other members wait for an upstream handoff. The designated Orchestrator
handles any additional assignments. Do not send duplicate start messages for work already launched
by the publication notification.

`Report to` and `Receive from` are declarations that Agents and Humans read. TeamHub does not
enforce them at run time: it will not block a message that ignores the topology. Follow the
protocol you published, and say so plainly when you deviate.

## 5. Handle failures precisely

A rejected submission writes nothing and notifies nobody. The error carries one issue per broken
rule, each with a `path`, a `code`, and a `message`:

- `team_md_pattern_invalid` / `team_md_pattern_missing`: use one of the five exact values;
- `team_md_actor_not_room_member`: that Actor is not in this Room. Add it to the Room or drop it
  from the document; do not swap in a different Agent to make the call succeed;
- `team_md_reference_unknown`: `Report to` or `Receive from` names someone the document never
  declares. Fix the name or declare the member;
- `team_md_actor_id_missing` / `team_md_actor_id_duplicated` / `team_md_name_duplicated`: each
  participant needs one unique name and one unique `ID`;
- `team_md_section_missing` / `team_md_section_unknown`: the document has exactly three sections —
  `Task Goal`, `Orchestrator`, `Team Member`.

Fix every reported issue and resubmit the whole document. Do not retry the identical content, and
do not report that a protocol was published after an error.
