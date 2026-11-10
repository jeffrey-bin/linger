# Deck brief template

Use this structure as the Task requirement. Fill every field; write "default"
where you chose a default. Refer to skills by name, never by a local file path.

```markdown
# Deck brief: <title>

Load the pptx skill first and follow it: find and use the Human's existing
material on this topic, research what is missing, build, and check every slide.
Do not ask questions. Follow this brief and report any change you made.
Storyline status: <confirmed by the user | not yet confirmed; the user may send changes>

## Audience and goal
- Audience: <who>
- Goal: <what they should think or do afterwards>
- Setting: <presented live | sent to read>, about <n> slides
- Language: <language of slide text>

## Main message
<one sentence>

## Look
- Style: <name, e.g. McKinsey blue, or the user's template> — background, text and accent colors (hex), fonts, layout habits
- Slide size: 16:9 unless stated

## Storyline
1. <claim headline> — <what the slide shows: data / chart / diagram / photo>
2. ...

## Topic for finding material
- Entities: <project, product, team, client, period, and aliases>
- Mentioned by the Human: <documents, files, rooms, people they named>
- Avoid: <topics, numbers or sources the Human excluded or that are sensitive for this audience>

## Facts from the conversation
- <quote anything the Human said that the deck needs>

## Output
- File: ./playground/<task-id>/<FileName>.pptx
- Speaker notes: <yes | no>
- Report back: file path, one line per slide, the Human's material found / used / not accessible, other sources, every assumption, every missing fact.
```

Rules for the Task:
- Keep the slide order and the meaning of each headline. You may sharpen
  wording or fix a headline the sources do not support; report each change.
- Take numbers only from the Human's material or cited web pages. Never invent
  them; a fact you cannot find becomes a visible gap.
