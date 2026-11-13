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

Each todo also has a project `listName` and an optional `sectionName`. Empty
strings mean uncategorized and no section. Named lists get a color from
`blue`, `orange`, `green`, `purple`, `rose`, `teal`, `amber`, `indigo`: the
first eight lists use each color once, then new lists reuse a stable hash.
`bb todo color <list> <color>` changes a list's color. A title may start with
`#List/Section ` or `#List `; the stored title drops that prefix unless
`--list` or `--section` is passed, in which case the flag wins.

## Commands

```sh
bb todo add "Ship the todo plugin" --bucket focus --list LightSpace --section "生产与上架"
bb todo add "#LightSpace/Hosting Station 写 demo 期方案"
bb todo propose "Hire a designer" --reason "Recurring request; own deliverable" --list LightSpace
bb todo color LightSpace teal
bb todo history --limit 20
bb todo undo
bb todo triage T-3 --action accept --bucket later
bb todo triage T-4 --action merge --into T-1
bb todo list --list LightSpace --section "生产与上架" --json
bb todo list --status inbox --json
bb todo show T-1 --json
bb todo log T-1 "Reviewed storage schema" --next-step "Write tests"
bb todo link T-1 --note "implementation thread"
bb todo start T-1 --prompt "先看失败的测试"
bb todo scan --list LightSpace --json
bb todo rm T-1
bb todo undo
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
inbox items. `rm` sets `deleted_at` and keeps logs and thread links. Creates,
edits, completions, triage, and deletes record a revision in the same
transaction. `history` lists them; `undo` writes the previous snapshot back.
Undoing a merge restores both the proposal and the target.

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
  IME composition is ignored. A selected project list is inherited unless the
  title itself starts with `#List`. On narrow screens the bucket pills wrap so
  the field stays wide, and every field uses at least 16px type so iOS does not
  zoom the page on focus.
- **Inbox**: proposals only appear when the inbox is non-empty. Each proposal
  shows its title, proposal reason, linked thread capsules, and accept
  (including a bucket selector), merge into an open formal todo, or dismiss.
- **Lists**: a capsule bar filters by project list. The selected list can change
  color. Inside one list, or with “按项目分组”, rows sit under a colored list
  heading and collapsible section headings.
- **Rows**: the round checkbox uses the list color. The collapsed row keeps a
  fixed right rail: a thread-count badge, an icon-only new-session button, and
  the disclosure. The title and next step wrap in the remaining column; the id
  and list chip sit on a quiet meta line. Expanded rows edit the list and
  section, show the full thread capsules, agent logs, delete, and the labeled
  new-session control. Log thread ids navigate to the linked BB thread. Unsaved edits in the open
  details stay put when a realtime refresh arrives; a clean form follows the
  server fields. Logs and thread capsules keep updating either way.
- **New session**: each open formal row has an icon button, and the expanded
  row also has a labeled `▶ 开启新会话` button. It asks
  `prepareStartSession` for a prompt that quotes up to five linked
  `@thread:` ids, then opens the composer with that draft and, when known, the
  linked project and environment.
- **Completed**: the bottom `已完成 (N)` drawer starts collapsed and restores a
  todo when its filled checkbox is clicked. The snapshot carries the 20 most
  recent completed items.
- **History**: `最近变更（可撤销）` lists recent revisions and can undo one
  that has not already been undone.
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
`prepareStartSession`, `setListColor`, `listRevisions`, `undoRevision`.
Every successful write publishes `todo:changed` on `bb.realtime`.
`prepareStartSession` does not write; `bb todo start` does.

`listSnapshot` returns `buckets` (`focus`, `later`, `waiting`, `inbox`), the 20
most recently completed `done` items, `counts` for sidebar badges, and `lists`
(`name`, `color`, `openCount`, `sections`) for named lists that still have open
formal todos.

## Storage

Migrations create `todo_items`, `todo_threads`, and `todo_logs`, then
`todo_list_meta` and `todo_revisions`. `list_name`, `section_name`, and
`deleted_at` are added with `PRAGMA table_info` so an existing database is not
altered twice. Writes that change a todo share a transaction with their
revision. Data survives reloads.

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
