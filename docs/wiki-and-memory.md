# Wiki and Memory

**On day one, it catches up on your past. Every day after, it keeps up with
you.**

![An animation over three days with one chat and one wiki page, Acme rollout.md: on Day 1 you connect Gmail and Another Me starts the page; on Day 4 you tell it the pricing you settled, and that night the page gains the pricing direction; on Day 9, in a Room, it answers what pricing you agreed on with a knowledge search over the page, and that night the page adds the March start and closes the pricing item](../assets/feature-wiki-memory.gif)

Connect your inbox, and Another Me reads back through the last few months to
start a wiki of your work: the people, the clients, the projects. From then on,
every conversation with your agents flows back in each night, and when a fact
changes, the page is rewritten and the change is logged. Tell it something
once, in any chat, and every agent working for you can find it later, in any
Room.

Linger remembers at two levels: a personal wiki about your work, which
every agent working for you can search, and a memory that each agent keeps of
its own conversations.

## Personal wiki

The wiki is a set of typed Markdown pages. Clients, contacts, projects and
topics each get one page per real-world entity, so every fact has one home, and
each conversation or meeting gets a Session page that links to the entities it
touched.

![A graph of wiki pages, with clients, contacts, projects, topics and sessions linked to each other, and the Acme rollout project page opened to show its sections: summaries kept or rewritten with a reason, lists changed entry by entry, and a Change Log the app writes](../assets/feature-wiki-pages.jpg)

| Page    | What it remembers                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------- |
| Client  | Who they are, how they work, needs and constraints, open and closed items, past contact             |
| Contact | Role, how you know them, how they work, what they care about, past contact                          |
| Project | Where it stands, its directions, open and closed items                                              |
| Topic   | An overview and your current understanding                                                          |
| Session | One conversation or meeting: summary, topics, decisions, action items, and patterns in how you work |

A model reads each new conversation or file and proposes changes section by
section, and the app checks every change against the page it replaces. A summary
section is either kept as it is or rewritten with a stated reason. A list
section changes one entry at a time, by an ID the app assigns, so entries the
update does not mention stay exactly as they were. Facts cite the message or
file version they came from, and a rewrite must keep every source the old text
cited or say why it dropped one. The Change Log is written by the app, not the
model: one dated line for each rewrite, edit, retraction or merge.

<sub>A summary section holds up to 3,000 characters. A list holds 20 entries of
up to 500 characters; past that, the model merges the oldest into one dated
entry. The Change Log keeps its newest 20 lines.</sub>

## Search

Agents search with the `teamhub knowledge` command, from any Room. The server
decides whose knowledge it is from the agent's registration, so an agent can
only search the knowledge of the person it works for. There are two indexes: the
wiki pages for overviews, and the original messages, transcripts, documents and
emails for exact details. An agent starts with the wiki and must search the
originals before it says something was never recorded.

| Step     | Wiki pages                                                                          | Originals                                                      |
| -------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Index    | One chunk per page, or per section for long pages; headings weigh most in keywords  | Chunks of each conversation, transcript, document or email     |
| Keywords | PostgreSQL full-text search, once for the query and once for each alternate wording | Same                                                           |
| Time     |                                                                                     | Keyword matches inside a time window the question names        |
| Fusion   | Reciprocal rank fusion of all lists                                                 | Same                                                           |
| Extra    |                                                                                     | Facts extracted from conversations, returned as their own list |
| Result   | Ranked previews; the agent reads the section it needs                               | Ranked passages with neighboring sections to read next         |

<sub>Agents pass up to six alternate wordings, such as synonyms and
translations, so a Chinese question can find an English page. Search uses
keywords only, with no embedding or reranker model. Another Me also has the
wiki as read-only files in its workspace.</sub>

## Agent memory

Each agent also learns from its own conversations, separately from your wiki.
Its memory crosses Rooms but not agents: what an agent learns in one Room it can
use in the next, and no other agent sees it. It keeps your preferences, proven
procedures, decisions, facts about the environment and lessons from failures,
and leaves out progress notes, generic advice, secrets and guesses.

![An animation of one agent's memory: Research Analyst's runs across Rooms count toward the next extraction; the fifth run starts an extraction that publishes a session summary at once and leaves candidate memories waiting; six hours with no run start a consolidation that merges duplicates, drops a disproven fact and writes the rest into MEMORY.md and summary.md; a new session in another Room gets the summary with its first message](../assets/feature-agent-memory.gif)

| Stage       | When                                                           | What happens                                                                 |
| ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Extract     | Every 5 successful runs of the agent                           | New messages and tool calls become a session summary and candidate memories  |
| Consolidate | After 6 hours with no run, or when the context is compacted    | Candidates merge into the memory; duplicates and disproven facts are removed |
| Recall      | First message of a new session, first message after compaction | The summary index is attached to that message; the rest is read on demand    |

Extraction and consolidation are model calls without tools on the agent's own
computer, with its Codex or Claude Code and the user's subscription. Extraction
waits for five runs because it shares the model with the conversation it reads.
Consolidation rewrites the whole memory, so it waits until the agent is idle.
The result is a read-only `agent-memory/` folder in every workspace of that
agent: `summary.md` as a short index, `MEMORY.md` organized by topic, and one
file per conversation under `session_summaries/`. The summary
travels as a hidden note on a message, never in the system prompt, so a new
memory does not invalidate the prompt cache or restart the agent.

<sub>Only Room conversations are read; delegated Tasks and document work are
not. Waiting candidates are merged early once they reach 64 KB or 30
conversations.</sub>
