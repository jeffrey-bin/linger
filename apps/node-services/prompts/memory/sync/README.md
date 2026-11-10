# Sync Prompts

This folder owns execution-level sync prompts. Each sync prompt consumes source
material and produces JSON file updates for the local memory store.

Levels:

- `daily/`: prompts that merge one day's room messages and runtime evidence.
- `weekly/`: prompts that refresh, promote, decay, and hibernate memory weekly.
- `client-memory/`: entity resolution and evidence-backed Client Wiki maintenance
  from session files.

All merge and update decisions happen inside the prompt text sent to the
configured memory model.
