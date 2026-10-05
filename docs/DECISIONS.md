# Decisions (feat/llm-steps)

Open choices made without asking, recorded as they come up. Newest at the bottom.

1. **Git push.** The brief says both "push to github after every phase" and "never push". I did
   not push: it is the outward-facing, harder-to-undo reading, and it is the more conservative
   one. Every phase is committed locally on `feat/llm-steps`; pushing is one command for you.
2. **Event names.** The new events use the exact names from the brief (`LLM_REQUESTED`, …).
   Existing events keep their PascalCase names; the mixed style is deliberate, not an accident.
3. **Task list.** There is no task-list tool in this environment, so progress is ticked off in
   `docs/TASKS.md`.
