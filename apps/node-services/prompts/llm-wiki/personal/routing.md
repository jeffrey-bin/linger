# Wiki Entity Routing

Read the supplied evidence once and name every durable entity it supports, so
that each entity's page can be written from the evidence routed to it. An
entity is durable when the Human has an ongoing relationship with it or it
keeps mattering to their work, not merely because it is named. Entity
pages are written later, each from its own routed evidence. Call `add_todo`
once per entity, with the exact raw references of the messages or Documents
that support it.

## Entity types

The Personal Wiki keeps one canonical page per real-world entity, of four
peer types:

- Client: an external organization the Human or their organization has an
  actual working or commercial relationship with: a customer, partner,
  supplier or prospect they are engaging. A company, venue, place, product or
  brand that only comes up in conversation is not a Client, and neither is a
  product or service the Human merely uses or has an account with.
- Contact: an external person the Human has an ongoing relationship with. A
  public figure, author or artist who is only discussed is not a Contact.
- Project: a named or clearly bounded ongoing initiative, recurring
  workstream, product build, research effort, or operational program with
  goals, deliverables, ownership, open work, or repeated execution.
- Topic: a field the Human follows and builds knowledge in: a research area,
  a domain of expertise, or a long-running interest they keep returning to. It
  has no deliverables or deadlines of its own. When the Human states their own
  research direction, expertise or lasting interest, route a Topic for it,
  even when a Project covers related work. A one-off question about a recipe,
  product, place or fact is not a Topic; the day's record keeps it.

Check every piece of evidence for all four types independently: one message
or Document may support a Client, a Contact, their Project and a Topic at
once. Work with goals, deliverables, deadlines or open tasks is a Project; the
field it belongs to can also be a Topic, under a name of its own (for example
a Project "Survey paper submission" and the Topic "Speech recognition").
Do not route the same work twice under two names. A deliverable, task, deadline,
meeting or event is not an entity of its own: route it to the Project, Client
or Contact it belongs to. It is valid to route nothing when the evidence
supports no durable entity: greetings, passing chatter, one-off questions and
the step-by-step progress of a single task belong to no page.

## When a new page is warranted

Route evidence to an existing page whenever it concerns that page's entity.
A new entity needs evidence of an ongoing relationship or recurring relevance,
for example:

- the Human took part: wrote, replied, met, decided, acted, or produced work
  about it;
- it recurs across separate interactions or dates;
- it is an active party in an ongoing initiative of the Human.

A Project or Topic is the Human's own work or interest: one the Human works
on, writes about or keeps returning to qualifies even when no other party is
involved.

Evidence that the Human did not engage with does not warrant a new page on its
own: a one-way message nobody answered, an automated or system-generated
notice, marketing or promotional content, or a single passing mention. A party
or event that appears once in the course of an initiative is part of that
initiative: route it to the initiative's existing or newly routed page instead
of giving it a page of its own.

## Existing pages

The entity registry lists every existing page with its path, name, aliases,
parts and last update. When the evidence concerns a listed entity, route it to
that page by its path. Name a new entity only when no listed page is the same
entity under another name or alias; a new name that matches a listed name,
alias or Project part is the listed entity. Before naming a new Project or
Topic, also check the other entities you route in this task: two names for the
same initiative or subject are one entity, routed once under the clearest
name, with the other name kept as an alias in the note.

## add_todo

- `type`: the entity type.
- `page`: the existing page path from the registry, or null for a new entity.
- `name`: the entity's canonical name as the evidence spells it.
- `slug`: for a new entity, a short lowercase ASCII file name built from the
  name (letters, digits and hyphens, for example `acme-robotics`); null for
  an existing page.
- `refs`: the exact `raw:S…` references of every message or Document in this
  evidence that supports a fact about the entity. Cite the messages that carry
  the facts, not the whole conversation.
- `note`: one or two sentences, in the main language of the evidence, on what
  the evidence adds about the entity, so the writer knows what to look for. The note is a pointer, not evidence: the
  page is written from the cited sources.

Route each entity once per task, with all of its references. Finish when every
supported entity has a todo.
