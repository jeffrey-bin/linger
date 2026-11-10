# Proactive Another Me

**It decides what deserves your attention, and every "thanks" or "not now"
shapes what it does next.**

![An animation of Another Me reaching out on its own: an email from Acme asking for a revised quote is set to follow up later and comes back as a reminder on Wednesday; you say client replies should come right away, and that night it learns "Client replies → Tell me right away". A late-evening standup change is told at once, you say late meeting changes can wait, and that night it learns "Meeting changes, after 9 PM → Follow up in the morning". Acme's next reply then comes at once, and a Sunday-night design review change waits until Monday morning, each by the rule it learned](../assets/feature-proactive.gif)

Another Me watches your inbox and calendar, decides what deserves your
attention, and reaches out on its own. When you push back with "tell me sooner"
or "not at this hour", it learns from that each night, and once you name the
kind of thing, it handles that kind your way from then on. Your rules stay on
your machine, with the rest of your memory.

## Decision

Another Me judges each window or event in a run of its own, with the general
rules, the user's learned rules and the open follow-up items, and acts on the
result.

| Stage           | Behavior                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input           | The chat with Another Me in windows of 20 messages; Gmail and Outlook inboxes, Google Calendar changes and Slack mentions, polled every 10 minutes |
| Apps            | From 22:00 to 08:00, or after five reminders that day, an app event is only recorded; one item in one state is judged once a day                   |
| Delivery        | Waits until the chat has been quiet for 3 minutes                                                                                                  |
| Tell now        | Another Me checks the facts that may have changed, then sends one short message: the point, the facts, the next step                               |
| Follow up later | A follow-up item with scheduled checks, recorded without a message                                                                                 |
| Stay silent     | The run ends without a reply                                                                                                                       |

## Learning rules

Each night, a model reads every message Another Me sent on its own with the 20
messages after it; a reply about how to be told becomes a clue, and clues of
the same kind become a rule.

| Reply                                              | Kept as                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| "Would have been good to hear this directly"       | Clue: Tell now                                                                                   |
| "From now on, tell me this kind directly"          | Rule: Tell now                                                                                   |
| "No need to push this"                             | Clue: Stay silent                                                                                |
| "Don't remind me now, but keep track of this kind" | Rule: Follow up later                                                                            |
| "Don't remind me about this kind"                  | Rule: Stay silent                                                                                |
| "Too late at night for this"                       | For a matter that needs follow-up: Follow up later in that time window, never straight to silent |
| "Great paper", "done", agreement, or no reply      | Nothing                                                                                          |

![An animation of what Another Me learns from your replies: on Wed, Oct 28 you answer the AWS invoice reminder with "I'd rather have heard when it arrived", and that night it becomes a clue for vendor invoices, Tell now; on Wed, Nov 4 you answer the Figma invoice reminder with "Again, should have pinged me when it came", and that night a second clue of the same kind arrives and both leave the pool as one rule, "Vendor invoices → Tell now"](../assets/feature-proactive-learn.gif)

## Applying what was learned

The learned rules are part of what Another Me reads before it judges a chat
window or an app event; clues are left out.
