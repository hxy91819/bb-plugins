---
name: bookmarks
description: Find, read, or delete conversation bookmarks saved by the user through message menus.
---

Use `bb bookmarks list --json` to find recent bookmarks; filter by project with
`--project <project-id>`. Returns `{bookmarks, total}`, with 100 rows by default.
Use `--limit <1-200> --offset <n>` for pagination.
Read full text, notes, and the source message with `bb bookmarks show <id> --json`.
Run `bb bookmarks rm <id> --json` only when the user requests deletion.
Missing IDs and invalid arguments return nonzero exit codes; JSON errors go to stderr.
Users create bookmarks with the message action or assistant text-selection menu,
and edit notes in the Bookmarks panel. The interface and CLI use English.
