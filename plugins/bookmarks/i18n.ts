export type Language = "en" | "zh-CN";
export function resolveLanguage(setting: unknown, browserLanguage = ""): Language {
  if (setting === "en" || setting === "zh-CN") return setting;
  return browserLanguage.startsWith("zh") ? "zh-CN" : "en";
}

export const messages = {
  en: {
    language: "Language", auto: "Auto",
    languageHelp: "Auto uses browser language (zh → 简体中文, otherwise English). Reload the browser after changing.",
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
  },
  "zh-CN": {
    language: "语言", auto: "自动",
    languageHelp: "自动跟随浏览器语言，修改后请刷新浏览器。",
    add: "加书签", panel: "书签", currentProject: "仅当前项目",
    search: "搜索书签", searchPlaceholder: "搜索文字、备注、会话或项目",
    saveNote: "保存备注", cancel: "取消", noteLabel: "书签备注", notePrefix: "备注：",
    copy: "复制文字", editNote: "改备注", remove: "删除", retry: "重试", loading: "正在加载…",
    noMatches: "没有匹配的书签", empty: "还没有书签。在消息上点击“加书签”，或选中回复文字后添加。",
    added: "已加书签", noteSaved: "备注已保存", copied: "文字已复制", removed: "书签已删除",
    addError: "添加书签失败，请重试", loadError: "加载书签失败，请重试", noteError: "保存备注失败，请重试",
    copyError: "复制失败，请重试", removeError: "删除书签失败，请重试", untitled: "未命名会话",
    open: (title: string) => `打开书签：${title}`,
    message: (seq: number) => `消息 ${seq}`,
    count: (count: number) => `共 ${new Intl.NumberFormat("zh-CN").format(count)} 条`,
  },
};
export function formatDate(date: string, language: Language) {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(date));
}

// Setup needs synchronous titles before a React component (and useSettings) exists.
// Read the same non-secret settings endpoint as the SDK hook before registration.
export async function readLanguageSetting(fetcher: typeof fetch): Promise<unknown> {
  try {
    const response = await fetcher("/api/v1/plugins/bookmarks/settings");
    const body = await response.json();
    return response.ok && body?.ok === true ? body.values?.language : undefined;
  } catch {
    return undefined;
  }
}
