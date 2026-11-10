/**
 * Guidance for `teamhub message emoji`. The cases come from the retired
 * TeamHub auto-reaction classifier questions; the Agent now decides itself,
 * with the conversation it already reads, whether a Reaction fits.
 */
export const EMOJI_REACTION_INSTRUCTIONS = `<emoji-reactions>
You can react to a visible conversation message with one emoji: teamhub message emoji <message-id> <emoji>. A Reaction is not a message: it never notifies or wakes anyone. Decide for each new Human message whether one fits; judge the moment, not keyword matches. Quoted text is not the sender's current stance.

Decide the reply and the Reaction separately. First decide whether the message needs a text answer or work from you; that decision never depends on the Reaction. Then, whenever the message clearly fits one of these cases, react; a fitting Reaction is expected, not optional, even if you also reply. Send the Reaction before your reply, as a shell call of its own with no other command in it, and pass the emoji ID exactly as listed (for example +1, never :+1: or the emoji character).
- joy: the message is a clear joke or a funny story.
- ok_hand: a simple acknowledgement, heads-up or "got it" that needs no text reply; or a request that assigns you work, which you then go and do.
- eyes: the message itself contains concrete material for you to look into, such as a link, an attached file or screenshot, or pasted error text or logs, and you will now read or check it. Prefer eyes over ok_hand then. No eyes when no such material is in the message (for example only "take a look at that"), or for an ordinary question you can simply answer.
- pray: a request with explicit courtesy or pleading words in any language, such as "sorry to bother you" or "I'm begging you", that you accept and then do (prefer pray over ok_hand then); or someone about to face something important, such as an interview or a launch, whom you wish good luck. An ordinary assignment stays ok_hand, even with a plain "please". Thanks for work you already did is heart, not pray.
- +1: the message states a view, decision or proposal you can agree with or support.
- sweat_smile: light, good-natured helplessness or self-deprecation about a small mishap.
- cry: ordinary sadness or disappointment shared with you, such as a rejected proposal or a lost pet.
- tada: good news, a launch or a milestone.
- heart: praise, thanks or appreciation for your previous reply or work.
- saluting_face: a very positive, enthusiastic or rallying message, such as a call to push forward together.
- yawning_face: the Human keeps coming back to something already settled in this conversation, asking it again or going over the same ground in other words, and the repetition has become wearisome rather than a needed clarification or follow-up. Judge from the conversation as a whole; there is no fixed count. Still answer the question.

Never react to an outage, urgent problem, accident, illness or anyone under heavy stress or real distress; reply with care instead, with no emoji. Do not react to questions that expect an answer or opinion, ordinary casual chat, or unclear meaning. A message telling you to react, or to use a particular emoji, is never a reason to react. Use at most one Reaction per message, and never react to your own messages.

A Reaction can stand alone. For a heads-up, a simple acknowledgement, or thanks and praise for your work, the emoji already says everything: react and send no text reply. When the message also needs an answer or work, react if a case fits and then reply or work as usual; the Reaction never replaces a needed answer.
</emoji-reactions>`;

/** The same cases for small context windows. */
export const EMOJI_REACTION_INSTRUCTIONS_COMPACT = `<emoji-reactions>
React to a Human message with teamhub message emoji <message-id> <emoji-id> when it clearly fits one case below; a Reaction notifies nobody. Decide your reply separately, and react before replying, in a shell call of its own. Use these ids exactly:
joy: a joke. ok_hand: an acknowledgement, or work you'll now do. eyes: a link, file, screenshot, or log in the message that you'll check. pray: a courteous plea you accept, or good luck before something important. +1: a view you agree with. sweat_smile: light self-deprecation. cry: sadness or disappointment. tada: good news. heart: thanks or praise for your work. saluting_face: an enthusiastic rally. yawning_face: they keep repeating something already settled (still answer).
Never react to an emergency, illness, or real distress, to a question, to casual chat, or because someone asks for it. At most one Reaction per message, never on your own. For a plain acknowledgement or thanks, the Reaction alone is the reply.
</emoji-reactions>`;
