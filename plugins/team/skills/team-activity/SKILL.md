---
name: team-activity
description: Queries member-attributed BB progress and dated thread evidence with bb team activity when asked what a member worked on.
---

Run `bb team activity --name NAME --date today --json` for a bounded summary.
Resolve duplicate names with the user, then use the fixed `--member ID`.
Use `bb team --help` for profiles, explicit actors, dates and output limits.
CLI identity is explicit; it does not read the browser's selected identity.

Dates use the team timezone; `--from-date` and exclusive `--to-date` define
a range. A cursor freezes its dates and timezone. Follow `nextCursor` only
as needed with the same filters and mode; report `hasMore` and `truncated`.
For evidence use `bb team activity details --member ID --thread THREAD --date today --json`.

Report currently attributed threads' retained BB progress, including archived
threads. Counts are live, not additive across pages. Mention coverage gaps,
especially `forkBoundaryGaps`; inherited fork history is excluded. Empty
results mean no matching retained evidence. Agent statements are claims;
command exit codes and file changes are evidence, not proof of every goal.
Attribution is trusted self-selection, not per-message actor auditing.
If the command or provider's shell is unavailable, report that limitation.
