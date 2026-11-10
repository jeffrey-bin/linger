---
name: slide-deck
description: Plan a new slide deck, PPT, presentation or pitch from the Meta chat and delegate the build. Use it whenever the Human asks for a new deck or a rebuilt one, before delegating anything; agree the audience, goal and storyline, show the plan, then delegate to a Task that finds the material and builds with the pptx skill. Not for Tasks, and not for small edits to an existing deck.
---

# Slide deck

A deck is good when it fits its audience and argues one clear story. This skill
is for the Meta: the high-level and content work (who it is for, what it must
achieve, the storyline) and the delegation. The Task does everything hands-on:
it finds and reads the Human's existing material, gets access to it, researches
the web and builds with the `pptx` skill.

## Meta (Room or personal chat)

Do these steps before `teamhub task create`. Do not delegate first and plan
later. Keep your turn short; do not search the workspace or the web for
material yourself. Speak in the Human's language.

1. **Small edit?** If the Human only wants to change an existing deck (a
   title, a number, one slide), skip this flow and delegate the edit with the
   `pptx` skill.
2. **Ask only what is missing.** Check the request and this conversation for
   three things: audience, style and number of slides. If any are missing,
   send one `teamhub message ask-user` card with only those questions, in that
   order, each with options, and end your turn. For style, propose 2–3 named
   professional looks that fit this topic and audience (e.g. "McKinsey blue:
   navy and white, action titles, dense exhibits"), each with a few words on
   palette and feel.
   If none are missing, or the Human is in a hurry, do not ask. Never ask
   whether to start or for material; the answers are the go-ahead.
3. **Draft the storyline**: infer the goal (decide, understand, be persuaded,
   get an update) and setting, then write one main message and one claim headline per
   slide. Use facts already stated in this conversation; where a headline
   needs a fact you do not have, phrase it as what the slide will show and
   leave the number to the Task. Storyline rules:
   - every headline is a claim, not a label; read in order they tell the story;
   - decide/approve: situation → problem → options → recommendation → ask;
     understand: why it matters → how it works → example → limits → summary;
     persuade: pain → promise → how → proof → call to action;
     update: headline numbers → what went well → what didn't → risks → asks;
   - open with the answer for leadership and investors; end with the ask or
     next step; about one slide per 1–2 minutes when presented.
4. **Show the plan with `teamhub message send`** (audience, slides, style, main
   message, headlines) and delegate in the same turn; the Human can still
   correct it.
5. **Delegate** with `teamhub task create --name "Deck: <topic>"
   --requirement-file <brief.md>`, writing the brief from
   [brief-template.md](brief-template.md). The Task cannot read this chat:
   quote everything from the conversation it needs (facts, names of projects,
   documents or files the Human mentioned, things to avoid), and refer to
   skills by name, never by local path.
6. **Deliver** when the Task reports: open the PPTX in `./playground/<task-id>/`,
   look at its rendered slides if the Task left them, and send one
   `teamhub message card` with the file attached, the Human's own material it
   used, and the missing facts so the Human can reply with them. Send fixes,
   feedback and those answers to the same Task with `teamhub task send`.

## In a Task

This skill is not for Tasks. Build with the `pptx` skill and follow the brief
in your requirement.
