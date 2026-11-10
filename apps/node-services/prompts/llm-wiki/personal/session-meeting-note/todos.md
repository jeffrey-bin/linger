# To-Dos: Extraction, Attribution, and Verification

Write the output in the user's language (the language the meeting or conversation was held in).

At the end, list together the follow-up actions the meeting explicitly raised for execution. Borrow the way open-source approaches verify claim, action, and target; do not copy Feishu cites, identity placeholders, or checkboxes. Judge separately whether an action is explicit and whether its owner can be identified: a real action with unclear ownership may be kept, but a mere suggestion cannot become a to-do by filling in "owner to be confirmed".

## 1. Identify Candidate Actions

Prioritize explicit commitments and claims ("I'll put it together", "I'll send it to you when I get back", "I'll confirm with them"), as well as statements that assign or agree on execution. Each item must state what specifically is done, for which object or deliverable, and be clearly treated in context as follow-up work; do not include it automatically just because of verbs like "organize" or "communicate".

Resolve what pronouns refer to only from the source. When the object still cannot be identified and whether it will be done is also unclear, leave it in the related discussion or in open questions that really exist; do not turn it into an executable task. Time is not a required factual basis; an explicit action may be included even without a deadline.

## 2. Distinguish Easily Confused Content

| Meaning in the source | Handling |
| --- | --- |
| A specific follow-up action that is explicitly claimed, assigned, or agreed | Include it, keeping its scope and conditions |
| Ideas such as "we could consider", "I suggest everyone", "some time later" | Keep in the discussion; include only if later explicitly turned into an execution arrangement |
| An already scheduled meeting, exam, or report date | Put it in the topic discussion; only explicit preparation, notification, or submission actions within it are to-dos |
| A decision to adopt a direction or option | It is a conclusion; do not derive a chain of execution tasks yourself |
| Sharing, sending, or demos already completed | Do not list as future to-dos; check whether later remarks say it was completed |
| In-meeting operations such as unmuting, screen sharing, or adding people | Not follow-up business to-dos |
| Describing someone else's approach or giving an example task | Not an arrangement of this meeting |

When the assignee has not explicitly accepted, do not write it as "claimed"; actions later declined or withdrawn are no longer listed as valid to-dos. When an incomplete transcript makes completion status impossible to judge, keep only actions with real follow-up significance and mark their status as to be confirmed.

## 3. Verify Owner, Time, and Preconditions

- "I'll do it" must map reliably to the actual speaker; "someone is responsible" must be checked against the specific assignee. When transcript name labels mix several people, do not assign directly by label.
- The person who asked, the task recipient, or the person to be contacted is not automatically the executing owner; mentioning a third party does not imply they attended. When the source explicitly makes a team responsible, keep the team name and do not invent an individual.
- When the action is explicit but the owner is undecided or attribution is unreliable, write "Owner: to be confirmed". Do not write a guess as definite attribution.
- Look across the whole text for additions, rescheduling, reassignment, cancellation, and completion of the same action, and use the last explicitly valid arrangement; a later proposal does not automatically override a previously confirmed arrangement.
- With no deadline, write "Time: to be confirmed". Convert a relative time only when the meeting date and reference point are explicit; otherwise keep the original wording such as "next Monday" and note that the exact date is to be confirmed. Never compute it from the date the notes are generated.
- Execution preconditions such as "after verification passes" or "after they confirm" must stay with the action; do not write a conditional arrangement as an unconditional commitment.

## 4. Deduplication and Wording

Merge repeated statements of the same execution object, goal, and action into one item, keeping the final owner, deadline, and conditions. List actions with different deliverables or different owners separately; consecutive steps for the same deliverable may be written in one item without mechanical splitting.

Start with a verb and state the action and its object clearly; each item focuses on one understandable delivery goal. Use an ordinary Markdown list:

`- **Specific action and object**. Owner: the person or team explicitly named in the source / to be confirmed; Time: the arrangement explicitly stated in the source / to be confirmed. Add execution preconditions when needed.`

This is an illustration, not placeholder text to fill in verbatim; write the labels ("Owner", "Time", "to be confirmed") in the output language too. Do not add a timestamp to each action, do not add unsupported priority or progress, and do not insert Feishu identity tags. When there are no explicit to-dos, write only "No explicit to-dos identified".

## 5. Verify After Extraction

Internally keep the source position for each action, and verify that the action really holds, the execution object is explicit, the owner is correctly attributed, the deadline is finally confirmed, preconditions are kept, and whether it was completed or withdrawn later. Check the whole text for missed explicit commitments, then merge duplicates. Finally check together with the [quality self-check](quality-checklist.md); the internal verification record need not be shown to the reader.
