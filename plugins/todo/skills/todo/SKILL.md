---
name: todo
description: Track todos with bb todo, automatically bind the current BB session when work starts, merge meeting or chat details into an existing todo instead of splitting new ones, scan for unblocked work to advance, and start a new session that carries the todo's linked thread context.
---

# Todo

Use `bb todo` whenever the user is working through a deliverable, asks to turn
meeting notes or chat logs into todos, asks for a new session to continue a
todo, or asks the agent to scan the todo list and advance unfinished work.

Todo ids are `T-1`, `T-2`, ...; every command accepts `T-1`, `t-1`, or `1`.
Add `--json` for machine-readable output. Buckets are `focus`, `later`,
`waiting`, and `inbox`; `inbox` holds AI proposals that the user must triage.

## Three rules

1. **Bind the session automatically.** When the conversation starts advancing
   an existing todo, run `bb todo list --json` to match it, then
   `bb todo link <id>` and `bb todo log <id> "<what happened>" --next-step "<next action>"`.
   Inside a BB thread this binds the current session without any flag; never
   ask the user to link manually. `bb todo log` also binds the current thread
   unless `--no-link` is passed. Linking again with an empty note does not
   clear a note that is already stored.

2. **One todo is one closable deliverable.** Each todo is a concrete
   deliverable or problem that one session can finish and accept: one
   checkable result. Do not split that into trivia such as "send one message"
   or "change one config line", and do not pack unrelated tasks into a
   grab-bag such as "day-to-day for project X". Tight substeps of the same
   deliverable go in that todo's `notes`, not in new todos.
   Before extracting todos from meeting notes, chat logs, or a messy request,
   run `bb todo list --status all --json` and check existing items, including
   inbox proposals. If the detail belongs to an existing todo, fold it in with
   `bb todo log <id> "..." --next-step "..."`; never create a new todo for it.
   Only propose a genuinely independent deliverable at that grain, and only
   through
   `bb todo propose "<title>" --reason "<source excerpt and why it is independent>"`.
   In extraction scenarios `bb todo add` is forbidden; it is for the user's
   explicit, direct request to add a todo.

3. **Scan and advance.** When the user asks to scan the todo list for work,
   run `bb todo scan --json`. Prefer items with `actionable: true` (unfinished,
   not `waiting`, and with no linked thread currently `starting` or `active`),
   especially `focus` before `later`. Run `bb todo link <id>` to bind the current
   session before starting, then record progress with `bb todo log` and close
   the item with `bb todo done`.

## Start a session

`bb todo start <id> [--project <projectId>] [--prompt "<extra>"]` spawns a new
thread and links it to the todo in the same step. The prompt names the todo,
its next step, a short note, and up to five linked `@thread:` lines (active
threads first, then the most recently linked). Project resolution is
`--project`, then the newest linked thread that still has a project, then the
current bb project. Pass `--project` when all three are missing.

The panel button「新会话」only prefills the composer. A session opened that way
does not exist until the user sends, so its prompt tells the new agent to run
`bb todo link <id>` first. `bb todo start` has already linked the spawned
thread; do not treat a missing link as an error if `bb todo show <id>` lists it.

## Commands

- `bb todo list [--status open|inbox|done|all] [--bucket focus|later|waiting|inbox] [--search <query>] [--json]`
- `bb todo show <id> [--json]`
- `bb todo add <title> [--bucket focus|later|waiting] [--notes <text>] [--next-step <text>] [--link-current] [--json]`
- `bb todo propose <title> --reason <text> [--notes <text>] [--next-step <text>] [--link-current] [--json]`
- `bb todo triage <id> --action accept|merge|dismiss [--bucket focus|later|waiting] [--into <target-id>] [--json]`
- `bb todo log <id> <text> [--next-step <text>] [--no-link] [--json]`
- `bb todo link <id> [--thread <threadId>] [--note <text>] [--json]`
- `bb todo unlink <id> [--thread <threadId>] [--json]`
- `bb todo start <id> [--project <projectId>] [--prompt <extra>] [--json]`
- `bb todo done <id> [--note <text>] [--json]` / `bb todo reopen <id> [--json]`
- `bb todo update <id> [--title <text>] [--bucket focus|later|waiting] [--notes <text>] [--next-step <text>] [--json]`
- `bb todo rm <id> [--json]`
- `bb todo scan [--json]`

Only accept, merge, or dismiss an inbox proposal when the user asks; proposals
exist so a human can veto new workstreams.
