<!--
Session fact extraction prompt: Hindsight's concise retain prompt, verbatim
except Example 1, whose content overlapped a public benchmark and is replaced
by an invented example of the same shape.
Source: vectorize-io/hindsight engine/retain/fact_extraction.py
(CONCISE_FACT_EXTRACTION_PROMPT), MIT License, Copyright (c) 2025 Vectorize AI, Inc.
-->

Extract SIGNIFICANT facts from text. Be SELECTIVE - only extract facts worth remembering long-term.

LANGUAGE: Write every fact in the same language and script as the input text. Never translate. Names, identifiers, code, and quoted text stay verbatim.

══════════════════════════════════════════════════════════════════════════
SELECTIVITY - CRITICAL (Reduces 90% of unnecessary output)
══════════════════════════════════════════════════════════════════════════

ONLY extract facts that are:
✅ Personal info: names, relationships, roles, background
✅ Preferences: likes, dislikes, habits, interests (e.g., "Alice likes coffee")
✅ Significant events: milestones, decisions, achievements, changes
✅ Plans/goals: future intentions, deadlines, commitments
✅ Expertise: skills, knowledge, certifications, experience
✅ Important context: projects, problems, constraints
✅ Sensory/emotional details: feelings, sensations, perceptions that provide context
✅ Observations: descriptions of people, places, things with specific details

DO NOT extract:
❌ Generic greetings: "how are you", "hello", pleasantries without substance
❌ Pure filler: "thanks", "sounds good", "ok", "got it", "sure"
❌ Process chatter: "let me check", "one moment", "I'll look into it"
❌ Repeated info: if already stated, don't extract again

CONSOLIDATE related statements into ONE fact when possible.

══════════════════════════════════════════════════════════════════════════
FACT FORMAT - BE CONCISE
══════════════════════════════════════════════════════════════════════════

1. "what": Core fact - concise but complete (1-2 sentences max)
2. "when": Temporal info if mentioned. "N/A" if none. Use day name when known.
3. "where": Location if relevant. "N/A" if none.
4. "who": People involved with relationships. "N/A" if just general info.
5. "why": Context/significance ONLY if important. "N/A" if obvious.

CONCISENESS: Capture the essence, not every word. One good sentence beats three mediocre ones.

══════════════════════════════════════════════════════════════════════════
COREFERENCE RESOLUTION
══════════════════════════════════════════════════════════════════════════

Link generic references to names when both appear:

- "my roommate" + "Emily" → use "Emily (user's roommate)"
- "the manager" + "Sarah" → use "Sarah (the manager)"

══════════════════════════════════════════════════════════════════════════
CLASSIFICATION
══════════════════════════════════════════════════════════════════════════

fact_kind:

- "event": Specific datable occurrence (set occurred_start/end)
- "conversation": Ongoing state, preference, trait (no dates)

fact_type:

- "world": Objective/external facts, including the user's preferences, rules, corrections, constraints, plans, traits, or context. These stay "world" even when the user states them during an assistant interaction (e.g., "User prefers browser_navigate over web_search", "User corrected the project deadline").
- "assistant": Actions, experiences, or observations the assistant/agent actually performed (e.g., "I changed X", "I discovered Y", "I debugged Z"). Use this for the assistant/agent doing, trying, learning, deciding, recommending, or responding — not merely for user facts mentioned in conversation.

══════════════════════════════════════════════════════════════════════════
TEMPORAL HANDLING
══════════════════════════════════════════════════════════════════════════

Use "Event Date" from input as reference for relative dates.

- CRITICAL: Convert ALL relative temporal expressions to absolute dates in the fact text itself.
  "yesterday" → write the resolved date (e.g. "on November 12, 2024"), NOT the word "yesterday"
  "last night", "this morning", "today", "tonight" → convert to the resolved absolute date
- For events: set occurred_start AND occurred_end (same for point events)
- Coarse dates (only a year, or only a month, is stated): span the WHOLE period —
  "in 2015" → 2015-01-01 to 2015-12-31, "in March 2026" → 2026-03-01 to 2026-03-31.
  Never collapse to the period's first day or to the Event Date, current year included.
- For conversation facts: NO occurred dates

══════════════════════════════════════════════════════════════════════════
ENTITIES
══════════════════════════════════════════════════════════════════════════

ALWAYS return "entities" as an array of plain strings — never objects, never null.
Correct: entities=["Alice", "Kubernetes", "CKA"]
Wrong: entities as an array of objects with a "text" key ← never use this form
Use an empty array [] only when the fact truly names nothing.

Include: people names, organizations, places, key objects, abstract concepts (career, friendship, etc.)
Always include "user" when fact is about the user.

══════════════════════════════════════════════════════════════════════════
EXAMPLES (shown in English for illustration; for non-English input, ALL output values MUST be in the input language)
══════════════════════════════════════════════════════════════════════════

The examples below demonstrate output format and selectivity only. Never emit
their facts, entities, or dates unless those details also appear in the actual
input text being processed.

Example 1 - Selective extraction (Event Date: March 14, 2024):
Input: "Hi there! Good morning. Can you suggest a beginner yoga routine? By the way, I started cello lessons last month and practice 30 minutes every morning. It's sunny today, so I'll walk to work."

Output: ONLY 1 fact (skip greetings, weather, the walk):

1. what="User started cello lessons and practices 30 minutes every morning", when="February 2024", who="user", why="N/A", fact_kind="event", occurred_start="2024-02-01", occurred_end="2024-02-29", entities=["user", "cello lessons"]

Example 2 - Professional context:
Input: "Alice has 5 years of Kubernetes experience and holds CKA certification. She's been leading the infrastructure team since March. By the way, she prefers dark roast coffee."

Output: ONLY 2 facts (skip coffee preference - too trivial):

1. what="Alice has 5 years Kubernetes experience, CKA certified", who="Alice", entities=["Alice", "Kubernetes", "CKA"]
2. what="Alice leads infrastructure team since March", who="Alice", entities=["Alice", "infrastructure"]

══════════════════════════════════════════════════════════════════════════
QUALITY OVER QUANTITY
══════════════════════════════════════════════════════════════════════════

Ask: "Would this be useful to recall in 6 months?" If no, skip it.

IMPORTANT: Sensory/emotional details and observations that provide meaningful context
about experiences ARE important to remember, even if they seem small (e.g., how food
tasted, how someone looked, how loud music was). Extract these if they characterize
an experience or person.
