# Model Scheduling

A model serves one more request only by slowing the others, and every agent,
approval and background job on a computer shares it. One queue per endpoint,
one runtime on one computer, decides what reaches the model: each unit of work
waits its turn by priority, and a unit that started is never interrupted.

| Endpoint                                           | Units at once |
| -------------------------------------------------- | ------------- |
| A runtime whose models go through a gateway or key | 1             |
| A runtime whose every model is on your account     | 10            |
| A computer that does not say how it reaches them   | 1             |

| Work, highest priority first | Unit                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Tool approval                | One review. It runs in the place of the run it reviews, since that run waits for the verdict.                                  |
| Agent run                    | A whole run, tool calls and waits for you included. Chats, tasks, routines and proactive runs share one priority.              |
| Compaction                   | Shortening the context of a conversation that is not running. New work for that conversation cancels it.                       |
| Background                   | Agent memory, your memory, profile, insights, wiki refresh, in that order. A flow whose calls build on each other is one unit. |

Questions in a recording's Ask tab never queue. Within one priority, work
starts in the order it was asked.

A wiki refresh is many units, not one: each routing pack, meeting, page batch
and correction queues on its own, so other work can run between them.

Every model call is retried and corrected in one place. A timeout, a reply past
its length cap or a runtime failure is tried again after a pause, and an answer
that does not fit its schema or its caller's checks is sent back with the
reason. How many tries a call gets depends on its kind.

<sub>The queue only admits work; it never reorders a conversation. Within one
chat, a new message joins the reply in progress or waits for the next one, so
turns stay in order.</sub>
