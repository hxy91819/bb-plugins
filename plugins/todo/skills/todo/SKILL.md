---
name: todo
description: Track macro todos with bb todo, automatically bind the current BB session when work starts, merge meeting or chat details into an existing todo instead of splitting new ones, and scan for unblocked work to advance.
---

# Todo

Use `bb todo` whenever the user is working on a multi-day or multi-week
workstream, asks to turn meeting notes or chat logs into todos, or asks the
agent to scan the todo list and advance unfinished work.

Todo ids are `T-1`, `T-2`, ...; every command accepts `T-1`, `t-1`, or `1`.
Add `--json` for machine-readable output. Buckets are `focus`, `later`,
`waiting`, and `inbox`; `inbox` holds AI proposals that the user must triage.

## Three rules

1. **Bind the session automatically.** When the conversation starts advancing
   an existing macro todo, run `bb todo list --json` to match it, then
   `bb todo link <id>` and `bb todo log <id> "<what happened>" --next-step "<next action>"`.
   Inside a BB thread this binds the current session without any flag; never
   ask the user to link manually. `bb todo log` also binds the current thread
   unless `--no-link` is passed.

2. **Never fragment macro work.** Before extracting todos from meeting notes,
   chat logs, or a messy request, run `bb todo list --status all --json` and
   check existing items, including inbox proposals. If the detail belongs to an
   existing macro todo (a specific discussion, small change, or reminder), fold
   it in with `bb todo log <id> "..." --next-step "..."`; never create a new todo
   for it. Only start a genuinely independent workstream with a separate
   deliverable that spans days or weeks, and only through
   `bb todo propose "<macro title>" --reason "<source excerpt and why it is independent>"`.
   In extraction scenarios `bb todo add` is forbidden; it is for the user's
   explicit, direct request to add a todo.

3. **Scan and advance.** When the user asks to scan the todo list for work,
   run `bb todo scan --json`. Prefer items with `actionable: true` (unfinished,
   not `waiting`, and with no linked thread currently `starting` or `active`),
   especially `focus` before `later`. Run `bb todo link <id>` to bind the current
   session before starting, then record progress with `bb todo log` and close
   the item with `bb todo done`.

## Commands

- `bb todo list [--status open|inbox|done|all] [--bucket focus|later|waiting|inbox] [--search <query>] [--json]`
- `bb todo show <id> [--json]`
- `bb todo add <title> [--bucket focus|later|waiting] [--notes <text>] [--next-step <text>] [--link-current] [--json]`
- `bb todo propose <title> --reason <text> [--notes <text>] [--next-step <text>] [--link-current] [--json]`
- `bb todo triage <id> --action accept|merge|dismiss [--bucket focus|later|waiting] [--into <target-id>] [--json]`
- `bb todo log <id> <text> [--next-step <text>] [--no-link] [--json]`
- `bb todo link <id> [--thread <threadId>] [--note <text>] [--json]`
- `bb todo unlink <id> [--thread <threadId>] [--json]`
- `bb todo done <id> [--note <text>] [--json]` / `bb todo reopen <id> [--json]`
- `bb todo update <id> [--title <text>] [--bucket focus|later|waiting] [--notes <text>] [--next-step <text>] [--json]`
- `bb todo rm <id> [--json]`
- `bb todo scan [--json]`

Only accept, merge, or dismiss an inbox proposal when the user asks; proposals
exist so a human can veto new workstreams.
