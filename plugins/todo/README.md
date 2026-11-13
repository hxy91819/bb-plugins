# Todo (`bb-plugin-todo`)

Lightweight Apple-style macro todos for BB. Phase 1 ships the shared contract,
SQLite storage, panel RPC, the `bb todo` CLI, and the built-in agent skill. The
Apple Reminders-style panel is a phase 2 deliverable; `app.tsx` is a compilable
placeholder that shows live counts.

## Model

| Bucket    | Meaning                                                        |
| --------- | -------------------------------------------------------------- |
| `focus`   | Formal todo the user intends to advance now (human default).  |
| `later`   | Formal todo to keep for later.                                 |
| `waiting` | Formal todo blocked on someone or something else.              |
| `inbox`   | AI proposal awaiting accept / merge / dismiss; never "open".   |

Ids are `T-<seq>` for the SQLite autoincrement primary key. Input accepts
`T-1`, `t-1`, or `1`. `logs` are newest first. `threads` are enriched with the
live bb thread title and status; a deleted or unreachable thread keeps its
`threadId` and gets `threadTitle: null` / `threadStatus: null`.

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

## Panel RPC and realtime

`contract.ts` is the single authority for types, RPC names, and the realtime
channel. Methods: `listSnapshot`, `quickAdd`, `update`, `setCompleted`,
`triageInbox`, `addLog`, `linkThread`, `unlinkThread`, `remove`. Every
successful write publishes `todo:changed` on `bb.realtime`.

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

Tests use `createFakePluginHost`, whose isolated temp-dir database is removed by
`harness.lifecycle.dispose()`; no fixture database is written into the repo.
