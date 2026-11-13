# Todo (`bb-plugin-todo`)

Lightweight Apple-style macro todos for BB. The plugin ships the shared
contract, SQLite storage, panel RPC, the `bb todo` CLI, the built-in agent skill,
and an Apple Reminders-style single-column panel. The panel is intentionally
small: a one-line add bar, quiet focus/later/waiting lists, an inbox triage strip
for agent proposals, inline row details, and a collapsed completed drawer.

## Model

| Bucket    | Meaning                                                        |
| --------- | -------------------------------------------------------------- |
| `focus`   | Formal todo the user intends to advance now (human default).  |
| `later`   | Formal todo to keep for later.                                 |
| `waiting` | Formal todo blocked on someone or something else.              |
| `inbox`   | AI proposal awaiting accept / merge / dismiss; never "open".   |

Ids are `T-<seq>` for the SQLite autoincrement primary key. Input accepts
`T-1`, `t-1`, or `1`. `logs` are newest first. `threads` are enriched with the
live bb thread title, status, `projectId`, and `environmentId` (`environmentId`
falls back to the included environment id). A deleted or unreachable thread
keeps its `threadId` and gets null title, status, project, and environment.

`sortOrder` breaks ties inside a bucket (ascending), then `seq`. Inbox proposals
are newest first; completed todos are newest completion first.

## Commands

```sh
bb todo add "Ship the todo plugin" --bucket focus --next-step "Run checks"
bb todo propose "Hire a designer" --reason "Recurring request; own deliverable"
bb todo triage T-3 --action accept --bucket later
bb todo triage T-4 --action merge --into T-1
bb todo list --json
bb todo list --status inbox --json
bb todo show T-1 --json
bb todo log T-1 "Reviewed storage schema" --next-step "Write tests"
bb todo link T-1 --note "implementation thread"
bb todo start T-1 --prompt "先看失败的测试"
bb todo scan --json
```

Every subcommand accepts `--json`. JSON failures use the plugin CLI envelope
`{"ok": false, "error": {"code", "message", "hint"}}` on stdout. `log`, `link`,
and `unlink` default to `ctx.threadId`; when there is no current thread, pass
`--thread`. `log` also binds the current thread unless `--no-link` is given.

`bb todo scan` returns `inboxCount` and every open formal todo with `nextStep`,
the latest log, linked threads, `hasRunningThread`, and `actionable`
(`bucket !== "waiting"` and no linked thread is `starting` or `active`).

`bb todo add` only creates formal todos. Inbox entries come exclusively from
`propose` and leave the inbox only through `triage`; `update` and `done` reject
inbox items.

`bb todo start <id>` builds the same prompt as the panel action, spawns a
thread with `project-default`, and links that thread back to the todo. The
project is `--project`, else the newest linked thread that still has a project,
else the current bb project. `--prompt` is appended after the generated text. Merging
an inbox item moves its existing logs onto the target and, when the target
`next step` is empty, copies the source `next step`. An empty thread note never
replaces a note already stored on the target.

## Panel

`app.tsx` registers the `todo` navigation panel at `/plugins/todo/todo`. The
host owns the title bar; the panel body starts with the add bar and never
repeats the page title.

- **Quick add**: type a title, press Enter (or the `+` button), and the todo is
  created in the selected `Focus` / `Later` / `Waiting` pill. Enter during an
  IME composition is ignored.
- **Inbox**: proposals only appear when the inbox is non-empty. Each proposal
  shows its title, proposal reason, linked thread capsules, and accept
  (including a bucket selector), merge into an open formal todo, or dismiss.
- **Rows**: the round checkbox completes a todo; the row expands inline to edit
  title, bucket, next step, and notes, with `⌘/Ctrl + Enter` or the Save button.
  Expanded rows also show agent progress logs, a delete button, and the same
  new-session control. Thread capsules (running ones carry a dot) and log
  thread ids navigate to the linked BB thread. Unsaved edits in the open
  details stay put when a realtime refresh arrives; a clean form follows the
  server fields. Logs and thread capsules keep updating either way.
- **New session**: each open formal row has a `▶ 新会话` pill. It asks
  `prepareStartSession` for a prompt that quotes up to five linked
  `@thread:` ids, then opens the composer with that draft and, when known, the
  linked project and environment.
- **Completed**: the bottom `已完成 (N)` drawer starts collapsed and restores a
  todo when its filled checkbox is clicked. The snapshot carries the 20 most
  recent completed items.
- **Badge**: the navigation badge prefers `inbox` proposals (`warning`), then
  `focus` items (`neutral`). It refreshes on `todo:changed` and falls back to
  no badge if the snapshot cannot be loaded.

SDK 0.6.75 does not export `experimental_threadContextCardRow` or
`experimental_ThreadContextCardRow`; the optional read-only thread context row
is therefore not registered. Revisit when the host SDK exposes that slot.

## Panel RPC and realtime

`contract.ts` is the single authority for types, RPC names, and the realtime
channel. Methods: `listSnapshot`, `quickAdd`, `update`, `setCompleted`,
`triageInbox`, `addLog`, `linkThread`, `unlinkThread`, `remove`,
`prepareStartSession`. Every successful write publishes `todo:changed` on
`bb.realtime`. `prepareStartSession` does not write; `bb todo start` does.

`listSnapshot` returns `buckets` (`focus`, `later`, `waiting`, `inbox`), the 20
most recently completed `done` items, and `counts` for sidebar badges.

## Storage

Migrations create `todo_items`, `todo_threads`, and `todo_logs` in the plugin's
own SQLite database at `<dataDir>/plugins/todo/data.db`. Writes are
transactional where they span tables, and data survives reloads.

## Development

From this directory with the pinned BB runtime:

```sh
npm run typecheck
npm test
npm run build
bb plugin types --check
```

`server.test.ts` uses `createFakePluginHost`, whose isolated temp-dir database
is removed by `harness.lifecycle.dispose()`; no fixture database is written into
the repo. `app.test.ts` uses JSDOM with `@get-bb/plugin-sdk/testing/app`
(`loadPluginApp` + `renderSlot`) and `@testing-library/react` to exercise quick
add, completion, inbox triage, thread navigation, inline edits, and the badge.
