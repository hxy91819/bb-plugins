# Thread list extras

The sidebar replacement keeps parent unread replies visible while parent or collapsed child work is running. It uses the existing trailing status position: the host unread dot when idle, or a rotating ring with a stationary envelope while working. Error, input, draft and plugin status priorities remain in effect.

Unread side chats also contribute to their source thread's status, including a side chat owned by a child thread. A collapsed row includes side-chat unread from the descendants listed in that row; expanded rows show each owner's status separately. Reading a source thread does not read its side chats. Archived rows do not show side-chat unread.

Open **Side chats** from the thread's panel launcher to browse its existing side chats. An unread mark identifies each unread chat; choose it to view it with BB's `ThreadChat`. Opening this list alone does not read any chat. The original **Start side chat** action remains available for creating a chat.

Side-chat state comes from the public SDK `threads.list` with `includeHidden`, `originKind: "fork"`, `originPluginId: "side-chat"`, and `archived: false`. All pages are loaded. The plugin refreshes every three seconds while the document is visible and on focus, retains its previous snapshot on failure, accepts results only from the most recently started refresh across sidebar and panel, and cancels requests when its UI unmounts. `ThreadChat` owns read tracking; the list plugin never writes read markers. For inspection outside the UI, use `bb thread list --include-hidden --json`, or `sdk.threads.list` with the filters above, and compare `lastReadAt ?? 0` with `latestAttentionAt`.

Layout preferences and their CLI commands are documented in [the plugin skill](skills/thread-list/SKILL.md).
