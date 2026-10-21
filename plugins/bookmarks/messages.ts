export const messages = {
  add: "Add bookmark", panel: "Bookmarks", currentProject: "Current project only",
  search: "Search bookmarks", searchPlaceholder: "Search text, notes, threads or projects",
  saveNote: "Save note", cancel: "Cancel", noteLabel: "Bookmark note", notePrefix: "Note: ",
  copy: "Copy text", editNote: "Edit note", remove: "Delete", retry: "Retry", loading: "Loading…",
  noMatches: "No matching bookmarks", empty: "No bookmarks yet. Click “Add bookmark” on a message or select reply text to add one.",
  added: "Bookmark added", noteSaved: "Note saved", copied: "Text copied", removed: "Bookmark deleted",
  addError: "Could not add bookmark. Please try again.", loadError: "Could not load bookmarks. Please try again.",
  noteError: "Could not save note. Please try again.", copyError: "Could not copy text. Please try again.",
  removeError: "Could not delete bookmark. Please try again.", untitled: "Untitled thread",
  open: (title: string) => `Open bookmark: ${title}`,
  message: (seq: number) => `Message ${seq}`,
  count: (count: number) => `${new Intl.NumberFormat("en").format(count)} ${count === 1 ? "bookmark" : "bookmarks"}`,
};
