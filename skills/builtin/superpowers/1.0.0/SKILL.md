---
name: superpowers
description: Use a disciplined workflow before coding. Apply when creating features, fixing bugs, or changing behavior. Establishes brainstorming, TDD, systematic debugging, and verification before claiming work is done.
---

# Superpowers

Use this Skill before building, fixing, or claiming completion. Skip a step only when the Human explicitly says to.

## 1. Frame the work

State the outcome, constraints, and how you will know it worked. If the request is creative or behavioral, clarify intent before writing code. If it is a bug, gather evidence before proposing a fix.

## 2. Choose the smallest path

Implement the simplest change that satisfies the current request. Do not design for requirements outside the current scope. Prefer existing tools and Skills over new infrastructure.

## 3. Test or reproduce first

For new behavior, write or extend a failing check before production code. For bugs, reproduce with a failing test, log, or exact command. Do not "fix forward" from a guess.

## 4. Change only what the request needs

After the check fails for the right reason, make the smallest production change. Then delete leftover code, unused branches, and abstractions the request does not require.

## 5. Verify before claiming done

Run the relevant tests or commands and read the output. Do not claim the work is complete, fixed, or passing unless the evidence is in this session.

## 6. Report evidence

Tell the Human what changed, what you ran, and the result. If verification failed, say so and keep going. Do not invent passing status.
