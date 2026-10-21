import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_copyToClipboard,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { bookmarkSchema, groupBookmarks, type Bookmark, type rpcContract } from "./contract";

import { messages, resolveLanguage, formatDate, readLanguageSetting, type Language } from "./i18n";
const actionButtonClassName = "cursor-pointer rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
let target: { threadId: string; id: string } | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getTarget = () => target;

async function addBookmark(threadId: string, messageSeq: number, text: string) {
  const response = await fetch("/api/v1/plugins/bookmarks/rpc/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, messageSeq, text }),
  });
  const body: unknown = await response.json();
  if (
    !response.ok ||
    typeof body !== "object" ||
    body === null ||
    !("ok" in body) ||
    body.ok !== true
  ) {
    throw new Error("Could not add bookmark");
  }
  return bookmarkSchema.parse("result" in body ? body.result : undefined);
}

function BookmarkRow({
  bookmark,
  onChanged,
  highlighted,
  language,
}: {
  bookmark: Bookmark;
  onChanged(): void;
  highlighted: boolean;
  language: Language;
}) {
  const m = messages[language];
  const title = bookmark.threadTitle || m.untitled;
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(bookmark.note);
  const [pending, setPending] = useState(false);
  const run = async (action: () => Promise<unknown>, success: string, failure: string) => {
    setPending(true);
    try {
      await action();
      toast.success(success);
      onChanged();
      return true;
    } catch {
      toast.error(failure);
      return false;
    } finally {
      setPending(false);
    }
  };
  const open = () => {
    const options = { split: false, experimental_messageSeq: bookmark.messageSeq };
    try {
      navigate.toThread(bookmark.threadId, options);
    } catch {
      navigate.toThread(bookmark.threadId);
    }
  };
  return (
    <li
      ref={(element) => { if (highlighted) element?.scrollIntoView({ block: "nearest" }); }}
      data-bookmark-id={bookmark.id}
      className={`rounded-lg border bg-card p-3 space-y-2 ${highlighted ? "border-primary ring-2 ring-primary" : "border-border"}`}
    >
      <button
        className="block w-full cursor-pointer rounded text-left space-y-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={open}
        aria-label={m.open(title)}
      >
        <span className="block text-xs text-muted-foreground">
          {title} · {m.message(bookmark.messageSeq)}
        </span>
        <span className="block whitespace-pre-wrap break-words text-sm max-h-64 overflow-y-auto">
          {bookmark.text}
        </span>
      </button>
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await run(() => rpc.call("note", { id: bookmark.id, note }), m.noteSaved, m.noteError))
              setEditing(false);
          }}
        >
          <textarea
            aria-label={m.noteLabel}
            className="w-full rounded border border-border bg-background p-2 text-sm"
            value={note}
            maxLength={20000}
            onChange={(event) => setNote(event.target.value)}
          />
          <button disabled={pending} type="submit" className={actionButtonClassName}>
            {m.saveNote}
          </button>{" "}
          <button
            type="button"
            disabled={pending}
            className={actionButtonClassName}
            onClick={() => setEditing(false)}
          >
            {m.cancel}
          </button>
        </form>
      ) : bookmark.note ? (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {m.notePrefix}{bookmark.note}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <time dateTime={bookmark.createdAt}>{formatDate(bookmark.createdAt, language)}</time>
        <button
          className={actionButtonClassName}
          disabled={pending}
          onClick={() =>
            void run(async () => {
              if (!(await experimental_copyToClipboard({ text: bookmark.text }))) {
                throw new Error(m.copyError);
              }
            }, m.copied, m.copyError)
          }
        >
          {m.copy}
        </button>
        <button
          className={actionButtonClassName}
          disabled={pending}
          onClick={() => {
            setNote(bookmark.note);
            setEditing(true);
          }}
        >
          {m.editNote}
        </button>
        <button
          className={actionButtonClassName}
          disabled={pending}
          onClick={() => void run(() => rpc.call("remove", { id: bookmark.id }), m.removed, m.removeError)}
        >
          {m.remove}
        </button>
      </div>
    </li>
  );
}

function BookmarksPanel({ threadId, language }: PluginThreadPanelProps & { language: Language }) {
  const m = messages[language];
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const requestedTarget = useSyncExternalStore(subscribe, getTarget);
  const selectedId = requestedTarget?.threadId === threadId ? requestedTarget.id : null;
  const [projectId, setProjectId] = useState<string | null>(null);
  const [currentProjectOnly, setCurrentProjectOnly] = useState(true);
  const [query, setQuery] = useState("");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useRealtime("changed", refresh);
  useEffect(() => {
    let active = true;
    setProjectId(null);
    sdk.threads.get({ threadId }).then(
      (thread) => { if (active) setProjectId(thread.projectId); },
      () => { if (active) { setError(m.loadError); setLoading(false); } },
    );
    return () => { active = false; };
  }, [sdk, threadId]);
  useEffect(() => {
    if (!selectedId) return;
    setQuery("");
    setCurrentProjectOnly(true);
    refresh();
  }, [selectedId, refresh]);
  useEffect(() => {
    if (projectId === null) return;
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      const load = async () => {
        const bookmarks: Bookmark[] = [];
        let total = 0;
        do {
          const page = await rpc.call("list", {
            query, ...(currentProjectOnly ? { projectId } : {}),
            limit: 200, offset: bookmarks.length,
          });
          if (!active) return { bookmarks, total };
          bookmarks.push(...page.bookmarks);
          total = page.total;
          if (page.bookmarks.length === 0) break;
        } while (bookmarks.length < total);
        return { bookmarks, total };
      };
      load().then(
        (result) => {
          if (!active) return;
          setBookmarks(result.bookmarks);
          setTotal(result.total);
          setError(null);
          setLoading(false);
        },
        () => {
          if (active) {
            setError(m.loadError);
            setLoading(false);
          }
        },
      );
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [rpc, query, projectId, currentProjectOnly, revision]);
  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={currentProjectOnly}
          onChange={(event) => setCurrentProjectOnly(event.target.checked)} />
        {m.currentProject}
      </label>
      <input
        aria-label={m.search}
        placeholder={m.searchPlaceholder}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}{" "}
          <button className={actionButtonClassName} onClick={refresh}>
            {m.retry}
          </button>
        </p>
      ) : loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.loading}
        </p>
      ) : (
        <>
          {bookmarks.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {query
                ? m.noMatches
                : m.empty}
            </p>
          )}
          {groupBookmarks(bookmarks, threadId, !currentProjectOnly).map((group) => (
            <section
              key={group.id}
              className="space-y-2"
              aria-label={group.title || m.untitled}
            >
              <h2 className="text-sm font-semibold">{group.title || m.untitled}</h2>
              <ul className="space-y-2">
                {group.bookmarks.map((bookmark) => (
                  <BookmarkRow
                    key={bookmark.id}
                    bookmark={bookmark}
                    language={language}
                    onChanged={refresh}
                    highlighted={bookmark.id === selectedId}
                  />
                ))}
              </ul>
            </section>
          ))}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{m.count(total)}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function createBookmarksApp(setting: unknown, browserLanguage = typeof navigator === "undefined" ? "" : navigator.language) {
  const language = resolveLanguage(setting, browserLanguage);
  const m = messages[language];
  return definePluginApp((app) => {
    app.slots.messageAction({
      id: "add-bookmark",
      title: m.add,
      icon: "bookmarks/bookmark",
      async run(context) {
        try {
          const bookmark = await addBookmark(
            context.threadId,
            context.message.experimental_messageSeq,
            context.selectedText ?? context.message.text,
          );
          target = { threadId: context.threadId, id: bookmark.id };
          listeners.forEach((listener) => listener());
          context.openPanel({ actionId: "bookmarks" });
          toast.success(m.added);
        } catch {
          toast.error(m.addError);
        }
      },
    });
    const panel = {
      id: "bookmarks",
      experimental_pinned: true,
      title: m.panel,
      icon: "bookmarks/bookmark",
      layout: "flush" as const,
      component: (props: PluginThreadPanelProps) => <BookmarksPanel {...props} language={language} />,
    };
    app.slots.threadPanelAction(panel);
  });
}

export default createBookmarksApp(
  typeof window === "undefined" ? undefined : await readLanguageSetting(fetch),
);
