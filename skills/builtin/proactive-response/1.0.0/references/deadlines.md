# Deadlines, todos and promises

## Routines it usually needs

- A matter with an exact due time: one reminder early enough to still do it (a day before for a large piece of work, a few hours before for a small one), and optionally one on the due day.
- A vague period ("next week", "by month end"): keep the original words in `due_text`; add a Routine only when the period is close enough to matter, such as the start of that week or a few days before the month ends.
- A promise to someone else ("promised Zhang San the proposal by Friday"): remind before the promised time, and name who is waiting.

## When to tell

- It is due today or overdue and not done: say what is due and suggest one next step.
- A blocker it depended on is gone (a reply arrived, a file is ready): tell that it can move forward now.
- Far from due and nothing changed: say nothing.

## When things change

- The Human says it is done: mark the item done; its Routines are removed at night.
- Postponed: update `due_at` or `due_text` in place and move the Routines.
- No longer needed: mark done and delete its Routines.
