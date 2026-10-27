import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  useBbNavigate,
  useSdk,
  type PluginThreadPanelProps,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { pageSize, searchMessages, type SearchResult } from "./search";

const controllers = new Map<
  string,
  { focus(): void; move(direction: number): void; visible(): boolean }
>();
const actionId = "find";
const buttonClass =
  "cursor-pointer rounded p-2 text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";

function highlight(match: SearchResult["matches"][number]): ReactNode {
  const parts: ReactNode[] = [];
  let start = 0;
  for (const range of match.highlightRanges) {
    parts.push(match.text.slice(start, range.start));
    parts.push(
      <mark key={range.start} className="rounded bg-primary/20 text-foreground">
        {match.text.slice(range.start, range.end)}
      </mark>,
    );
    start = range.end;
  }
  parts.push(match.text.slice(start));
  return parts;
}

function SearchPanel({ threadId }: PluginThreadPanelProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lastNavigation = useRef("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [navigationRequest, setNavigationRequest] = useState(0);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    threadId: string;
    term: string;
    data: SearchResult;
  } | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [closing, setClosing] = useState(false);
  const term = query.trim();
  const offset = Math.floor(Math.max(active, 0) / pageSize) * pageSize;
  const key = JSON.stringify([threadId, term, offset, revision]);
  const data = result?.key === key ? result.data : null;
  const error = failure?.key === key ? failure.message : null;
  const loading = term.length > 0 && !data && !error;
  const total =
    data?.total ??
    (result?.threadId === threadId && result.term === term
      ? result.data.total
      : 0);
  const move = useCallback(
    (direction: number) => {
      if (total === 0) return;
      setNavigationRequest((value) => value + 1);
      setActive((current) =>
        current < 0
          ? direction > 0
            ? 0
            : total - 1
          : (current + direction + total) % total,
      );
    },
    [total],
  );
  const focus = () => {
    input.current?.focus();
    input.current?.select();
  };
  useEffect(() => {
    const controller = {
      focus,
      move,
      visible: () => (root.current?.getClientRects().length ?? 0) > 0,
    };
    controllers.set(threadId, controller);
    return () => {
      if (controllers.get(threadId) === controller)
        controllers.delete(threadId);
    };
  }, [threadId, move]);
  useEffect(() => {
    setQuery("");
    setActive(-1);
    focus();
  }, [threadId]);
  useEffect(() => {
    if (!term) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchMessages(sdk.threads, {
        threadId,
        query: term,
        limit: pageSize,
        offset,
        signal: controller.signal,
      }).then(
        (data) => {
          if (!controller.signal.aborted) {
            setFailure(null);
            setResult({ key, threadId, term, data });
          }
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setFailure({
              key,
              message:
                error instanceof Error
                  ? error.message
                  : "Unable to search this conversation.",
            });
        },
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [sdk, threadId, term, offset, key]);
  useEffect(() => {
    if (!data || active < 0) return;
    if (active >= data.total) {
      setActive(data.total - 1);
      return;
    }
    const match = data.matches[active - offset];
    const navigationKey = JSON.stringify([key, active, navigationRequest]);
    if (match && lastNavigation.current !== navigationKey) {
      lastNavigation.current = navigationKey;
      const options = { experimental_messageSeq: match.sourceSeq };
      navigate.toThread(threadId, options);
    }
  }, [data, active, offset, navigate, threadId, key, navigationRequest]);
  const close = async () => {
    if (closing) return;
    setClosing(true);
    try {
      const current = await sdk.threads.tabs.get({ threadId });
      await sdk.threads.tabs.update({
        threadId,
        expectedRevision: current.revision,
        tabs: current.tabs.filter(
          (tab) =>
            !(
              tab.kind === "plugin-panel" &&
              tab.pluginId === "thread-search" &&
              tab.actionId === actionId
            ),
        ),
      });
    } catch (error: unknown) {
      setFailure({
        key,
        message:
          error instanceof Error
            ? error.message
            : "Unable to close search. Please try again.",
      });
    } finally {
      setClosing(false);
    }
  };
  return (
    <div
      ref={root}
      className="flex h-full flex-col gap-3 p-3"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          void close();
        }
        if (event.key === "Enter" && event.target === input.current) {
          event.preventDefault();
          move(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <div className="flex items-center gap-1">
        <input
          ref={input}
          type="search"
          value={query}
          maxLength={1000}
          aria-label="Find in conversation"
          placeholder="Find in conversation"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(-1);
          }}
        />
        <button
          className={buttonClass}
          aria-label="Close search"
          title="Close search (Esc)"
          disabled={closing}
          onClick={() => void close()}
        >
          ×
        </button>
      </div>
      <div className="flex items-center gap-1 text-xs">
        <span
          className="mr-auto text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {loading
            ? "Searching…"
            : term && data
              ? `${active < 0 ? 0 : active + 1} / ${data.total} matching messages`
              : "Search all user messages and assistant replies"}
        </span>
        <button
          className={buttonClass}
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={!total || loading}
          onClick={() => move(-1)}
        >
          ↑
        </button>
        <button
          className={buttonClass}
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={!total || loading}
          onClick={() => move(1)}
        >
          ↓
        </button>
        <button
          className={buttonClass}
          aria-label="Refresh search"
          disabled={!term || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          ↻
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {data?.total === 0 && (
        <p className="text-sm text-muted-foreground">No matching messages.</p>
      )}
      <ol
        className="min-h-0 flex-1 space-y-2 overflow-y-auto"
        aria-label="Matching messages"
      >
        {data?.matches.map((match, index) => (
          <li key={match.sourceSeq}>
            <button
              className={`w-full cursor-pointer rounded-lg border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active === offset + index ? "border-primary bg-primary/10" : "border-border hover:bg-state-hover"}`}
              aria-current={active === offset + index ? "true" : undefined}
              onClick={() => {
                setActive(offset + index);
                setNavigationRequest((value) => value + 1);
              }}
            >
              <span className="mb-1 block text-xs text-muted-foreground">
                {match.sourceKind === "user_message" ? "You" : "Assistant"} ·
                Message {match.sourceSeq}
              </span>
              <span className="block whitespace-pre-wrap break-words text-sm">
                {highlight(match)}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {data && data.total > pageSize && (
        <div className="flex items-center justify-between text-xs">
          <button
            className={buttonClass}
            disabled={offset === 0}
            onClick={() => setActive(Math.max(0, offset - pageSize))}
          >
            Previous page
          </button>
          <span>
            {offset + 1}–{Math.min(offset + pageSize, data.total)} of{" "}
            {data.total}
          </span>
          <button
            className={buttonClass}
            disabled={offset + pageSize >= data.total}
            onClick={() => setActive(offset + pageSize)}
          >
            Next page
          </button>
        </div>
      )}
    </div>
  );
}

function HeaderAction({ threadId }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return (
    <button
      className="inline-flex size-7 cursor-pointer items-center justify-center rounded hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Find in conversation"
      title="Find in conversation"
      onClick={() => {
        if (navigate.openThreadPanel({ actionId }))
          controllers.get(threadId)?.focus();
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </svg>
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: actionId,
    title: "Find in conversation",
    icon: "Search",
    layout: "flush",
    component: SearchPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "find",
    title: "Find in conversation",
    component: HeaderAction,
  });
  app.commands.register({
    id: "find",
    title: "Conversation Search: find in current conversation",
    defaultShortcut: { key: "f", mod: true, shift: true },
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId, openPanel }) => {
      if (threadId && openPanel({ actionId }))
        controllers.get(threadId)?.focus();
    },
  });
  for (const [id, direction, shift] of [
    ["next", 1, false],
    ["previous", -1, true],
  ] as const) {
    app.commands.register({
      id,
      title: `Conversation Search: ${id} matching message`,
      defaultShortcut: { key: "g", mod: true, shift },
      isAvailable: ({ threadId }) =>
        threadId !== null && (controllers.get(threadId)?.visible() ?? false),
      run: ({ threadId }) => {
        if (threadId) controllers.get(threadId)?.move(direction);
      },
    });
  }
});
