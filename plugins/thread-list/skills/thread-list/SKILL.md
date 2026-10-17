---
name: thread-list
description: "Inspect or change the sidebar thread list's layout preferences: organization mode, sort, section order, hidden groups, collapsed groups, and thread row actions."
---

# Thread list preferences

The Thread list plugin owns the sidebar's layout state. Read it with
`bb thread-list-extras prefs list --json`; keys are `showProviderIcons`, `threadLifecycles`, `organizationMode`,
`environmentGrouping`, `groupByReadStatus`, `chronologicalSort`, `dateGrouping`, `sortDirection`, `sectionOrder`,
`manualSectionOrder`, `machineSectionOrder`, `contributionGroupOrder`, `hiddenGroups` (including the
built-in `threads` group), `rowActions`,
`collapsedSections`, `collapsedProjects`, `collapsedThreads`,
`collapsedEnvironments`, `collapsedThreadSections`, `collapsedMachines`, and `collapsedContributionGroups`.

```sh
bb thread-list-extras prefs list [--json]
bb thread-list-extras prefs get <key> [--json]
bb thread-list-extras prefs set <key> <value> [--json]
bb thread-list-extras prefs reset <key> [--json]
```

`set` takes JSON; a bare word is read as a string, so
`bb thread-list-extras prefs set organizationMode machine` and
`bb thread-list-extras prefs set manualSectionOrder '["pinned","sections","threads"]'`
both work. A value the key's schema rejects fails with
`invalid_preference_value` and leaves the stored value alone. Every open
window applies a change immediately. Sections themselves and a thread's
section are bb core state: use `bb thread section` and `bb thread update`.

On first load the plugin copies any non-default `sidebar.*` values from
`bb settings ui` once; after that the two are independent.

The header's Filter menu selects Active, Archived, or both; at least one must
remain selected. `bb thread-list-extras prefs set threadLifecycles '["archived"]'`
shows archived threads, and `'["active","archived"]'` shows both. The default
is `'["active"]'`. Archived results load in pages; use Show more at the end
of the list. The same preference is available through `setPreference` RPC.

`rowActions` picks up to three quick-action buttons a thread row shows on
hover, left to right before its actions menu, as thread action keys: bb's
`bb--core/split`, `bb--core/copyLink`, `bb--core/read`, `bb--core/pin`,
`bb--core/rename`, `bb--core/archive`, `bb--core/delete`, the list's
`thread-list-extras/move` (opens a section menu), or another plugin's
`<pluginId>/<actionId>`. Bare legacy ids such as `archive` and `core/<id>`
keys still work. The default is `'["bb--core/archive"]'` and `'[]'` leaves
only the menu. For example,
`bb thread-list-extras prefs set rowActions '["bb--core/pin","bb--core/archive"]'`.
In the app, a thread
row's actions menu has Customize row actions, which turns that row's quick
actions into three editable slots in place; each slot picks an action, a filled
slot can Hide, and filled slots drag to reorder. Done, Escape, or a click
elsewhere finishes.

Organize → Rows → Provider icons toggles the icon before each thread title.
`showProviderIcons` defaults to `true`; use
`bb thread-list-extras prefs set showProviderIcons false` to hide them. Unknown
provider ids have no icon.

Organize → Groups → By read status lists threads that show the unread dot above
the rest, keeping the selected sort within each group. `groupByReadStatus`
defaults to `false`; use `bb thread-list-extras prefs set groupByReadStatus true` to
turn it on. Parents start collapsed while it is on, without changing
`collapsedThreads`, and `environmentGrouping` is ignored. The open thread keeps
its place until another thread is opened.

New threads inherit the sidebar group where creation was invoked. Pinned
creates pinned threads; custom sections supply their section; project, machine,
and general thread groups start unsectioned and unpinned. Environment rows
reuse their environment and the containing group's placement. In Pinned,
they retain the group's common underlying section for unpinning; mixed-section
groups use no underlying section.

## Date groups

`dateGrouping` defaults to `true`. Organize → Rows → Date groups toggles it;
`bb thread-list-extras prefs set dateGrouping false` or `setPreference` RPC does the same.
It only groups root entries in Custom's built-in Threads section. Pinned,
custom sections, By project, and By machine are unchanged. Alphabetical sorting
disables the toggle and hides date groups without changing the saved preference.

Date groups and By read status are exclusive. Enabling either through the UI,
CLI, or RPC turns the other off; resetting `dateGrouping` also turns By read
status off. If older saved values enable both, By read status takes precedence
and date headings stay hidden.

Updated sorting groups by the same key it sorts by: a thread's latest activity
(`latestAttentionAt`), with running threads counted as today; metadata edits such
as pinning do not move a thread. Created sorting uses `createdAt`. Buckets use
local calendar days: Today, Yesterday, English weekday names for 2–6 days ago,
Previous 30 days for 7–29 days ago, then English month and numeric year (for
example, September 2026). Headings are always English, matching the rest of the
sidebar, regardless of the browser locale. Nested children and worktree siblings
stay with their root thread or environment representative's date. Archived threads
share the same buckets when included by Filter. Headings are display-only, not
collapsible, draggable, or keyboard jump targets; there are no priority or
needs-input buckets. Dates refresh at local midnight and on window focus.

## Plugin contributions

Organization defaults to `chronological`. Organize → Sections also lists registered
plugin grouping providers. Select one with
`bb thread-list-extras prefs set organizationMode <pluginId>/<registrationId>`.
Only the selected provider reads all candidate root IDs, before folding and
windowing. Installing a provider does not change the selection. If it is absent
or fails, the list uses chronological temporarily and preserves the preference
for recovery. Row additions from enabled plugins compose in stable owner/key
order in every mode; they do not replace titles, status, navigation or actions.

Contributed groups keep complete parent trees; a child can show different row
information. Environment groups stay inside the root group. Their headers are
read-only metadata projections: dropping across groups does not change metadata.
`hiddenGroups`, `collapsedContributionGroups` and `contributionGroupOrder` use
canonical keys: `contribution:` followed by
`encodeURIComponent(JSON.stringify([providerKey, kind, groupKey]))`. `kind` is
`group`, `ungrouped` or `loading`; the latter two use an empty `groupKey`.
Use IDs returned by preferences rather than constructing keys by joining
delimiters. Renaming a label keeps its state; other providers retain their state.
