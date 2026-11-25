import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  type ExperimentalBadge,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  TODO_CHANGED_EVENT,
  TODO_COLORS,
  TODO_FORMAL_BUCKETS,
  TODO_START_RELATED_LIMIT,
  parseTitlePrefix,
  type TodoColor,
  type TodoCounts,
  type TodoFormalBucket,
  type TodoItem,
  type TodoListSummary,
  type TodoLogEntry,
  type TodoRevision,
  type TodoSnapshot,
  type TodoSuggestion,
  type TodoThreadLink,
  type rpcContract,
} from "./contract";

const FORMAL_BUCKETS: readonly TodoFormalBucket[] = TODO_FORMAL_BUCKETS;

const BUCKET_LABEL: Record<TodoFormalBucket, string> = {
  focus: "Focus",
  later: "Later",
  waiting: "Waiting",
};

const BUCKET_CAPTION: Record<TodoFormalBucket, string> = {
  focus: "正在推进",
  later: "稍后处理",
  waiting: "等待中",
};

/** Saturated dots that stay visible on both light and dark surfaces. Text stays foreground. */
const COLOR_STYLE: Record<TodoColor, { solid: string; soft: string }> = {
  blue: { solid: "#007AFF", soft: "rgba(0,122,255,0.14)" },
  orange: { solid: "#FF9F0A", soft: "rgba(255,159,10,0.18)" },
  green: { solid: "#34C759", soft: "rgba(52,199,89,0.16)" },
  purple: { solid: "#AF52DE", soft: "rgba(175,82,222,0.16)" },
  rose: { solid: "#FF375F", soft: "rgba(255,55,95,0.14)" },
  teal: { solid: "#30B0C7", soft: "rgba(48,176,199,0.16)" },
  amber: { solid: "#C48A00", soft: "rgba(196,138,0,0.18)" },
  indigo: { solid: "#5856D6", soft: "rgba(88,86,214,0.16)" },
};

const VIEW_STATE_STORAGE_KEY = "bb-plugin-todo:view-state:v1";

type TodoViewState = {
  listFilter: string | null;
  groupByList: boolean;
  collapsedSections: string[];
  showDone: boolean;
};

const DEFAULT_VIEW_STATE: TodoViewState = {
  listFilter: null,
  groupByList: true,
  collapsedSections: [],
  showDone: false,
};

function viewStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    // Private mode can throw on access; the panel still works in memory.
    return null;
  }
}

function readViewState(): TodoViewState {
  const store = viewStorage();
  if (store === null) return DEFAULT_VIEW_STATE;
  try {
    const raw = store.getItem(VIEW_STATE_STORAGE_KEY);
    if (raw === null) return DEFAULT_VIEW_STATE;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_VIEW_STATE;
    const record = parsed as Record<string, unknown>;
    return {
      listFilter:
        record.listFilter === null || typeof record.listFilter === "string"
          ? record.listFilter
          : DEFAULT_VIEW_STATE.listFilter,
      groupByList:
        typeof record.groupByList === "boolean"
          ? record.groupByList
          : DEFAULT_VIEW_STATE.groupByList,
      collapsedSections: Array.isArray(record.collapsedSections)
        ? record.collapsedSections.filter((value): value is string => typeof value === "string")
        : [],
      showDone:
        typeof record.showDone === "boolean" ? record.showDone : DEFAULT_VIEW_STATE.showDone,
    };
  } catch {
    return DEFAULT_VIEW_STATE;
  }
}

function writeViewState(state: TodoViewState): void {
  const store = viewStorage();
  if (store === null) return;
  try {
    store.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota or private-mode failures must never break the panel.
  }
}

const fieldClassName =
  "w-full touch-manipulation rounded-lg border border-border bg-background px-2.5 py-1.5 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm";
const quietButtonClassName =
  "touch-manipulation cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const primaryButtonClassName =
  "touch-manipulation cursor-pointer rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const iconButtonClassName =
  "touch-manipulation flex h-7 w-7 shrink-0 cursor-pointer appearance-none items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : timeFormatter.format(date);
}

function threadLabel(link: TodoThreadLink): string {
  return link.threadTitle || link.threadId.slice(0, 10);
}

function shortThreadId(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 12)}…` : threadId;
}

function isRunningStatus(status: string | null | undefined): boolean {
  return status === "active" || status === "starting";
}

function actorLabel(actor: string): string {
  return actor.startsWith("agent:") ? `@thread:${actor.slice("agent:".length)}` : "人工";
}

function colorOf(lists: TodoListSummary[], listName: string): TodoColor | null {
  if (listName.length === 0) return null;
  return lists.find((list) => list.name === listName)?.color ?? null;
}

type DropTarget = {
  bucket: TodoFormalBucket;
  listName: string;
  sectionName: string;
  beforeId: string | null;
};

function sameDropGroup(
  target: DropTarget,
  bucket: string,
  listName: string,
  sectionName: string,
): boolean {
  return target.bucket === bucket && target.listName === listName && target.sectionName === sectionName;
}

function visibleTodoIds(
  snapshot: TodoSnapshot,
  listFilter: string | null,
  groupByList: boolean,
  collapsedSections: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  for (const bucket of FORMAL_BUCKETS) {
    const visible = snapshot.buckets[bucket].filter(
      (item) => listFilter === null || item.listName === listFilter,
    );
    if (visible.length === 0) continue;
    const grouped = listFilter !== null || groupByList;
    if (!grouped) {
      ids.push(...visible.map((item) => item.id));
      continue;
    }
    const showListHeaders = groupByList && listFilter === null;
    const listOrder = showListHeaders
      ? [...new Set(visible.map((item) => item.listName))]
      : [listFilter ?? ""];
    for (const listName of listOrder) {
      const inList = showListHeaders ? visible.filter((item) => item.listName === listName) : visible;
      for (const item of inList) {
        if (item.sectionName.length === 0) ids.push(item.id);
      }
      const sectionNames = [
        ...new Set(inList.map((item) => item.sectionName).filter((name) => name.length > 0)),
      ];
      for (const sectionName of sectionNames) {
        if (collapsedSections.has(`${listName}\0${sectionName}`)) continue;
        for (const item of inList) {
          if (item.sectionName === sectionName) ids.push(item.id);
        }
      }
    }
  }
  return ids;
}

function readDropTarget(x: number, y: number, grouped: boolean): DropTarget | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const row = hit.closest("[data-todo-row]");
  if (row instanceof HTMLElement && row.dataset.todoId && row.dataset.todoBucket) {
    const bucket = row.dataset.todoBucket;
    if (bucket !== "focus" && bucket !== "later" && bucket !== "waiting") return null;
    const listName = row.dataset.todoList ?? "";
    const sectionName = row.dataset.todoSection ?? "";
    const rect = row.getBoundingClientRect();
    const after = rect.height > 0 && y >= rect.top + rect.height / 2;
    return {
      bucket,
      listName,
      sectionName,
      beforeId: after ? (grouped ? nextRowInGroup(row) : nextVisibleInBucket(row)) : row.dataset.todoId,
    };
  }
  const zone = hit.closest("[data-todo-drop-end]");
  if (!(zone instanceof HTMLElement) || !zone.dataset.todoBucket) return null;
  const bucket = zone.dataset.todoBucket;
  if (bucket !== "focus" && bucket !== "later" && bucket !== "waiting") return null;
  return {
    bucket,
    listName: zone.dataset.todoList ?? "",
    sectionName: zone.dataset.todoSection ?? "",
    beforeId: null,
  };
}

function nextVisibleInBucket(row: HTMLElement): string | null {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-todo-row]")];
  const index = rows.indexOf(row);
  const next = rows[index + 1];
  if (!next || next.dataset.todoBucket !== row.dataset.todoBucket) return null;
  return next.dataset.todoId ?? null;
}

function nextRowInGroup(row: HTMLElement): string | null {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-todo-row]")];
  const index = rows.indexOf(row);
  const bucket = row.dataset.todoBucket ?? "";
  const listName = row.dataset.todoList ?? "";
  const sectionName = row.dataset.todoSection ?? "";
  for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
    const candidate = rows[cursor]!;
    if (
      (candidate.dataset.todoBucket ?? "") !== bucket ||
      (candidate.dataset.todoList ?? "") !== listName ||
      (candidate.dataset.todoSection ?? "") !== sectionName
    ) {
      return null;
    }
    return candidate.dataset.todoId ?? null;
  }
  return null;
}

function resolveBeforeId(
  target: DropTarget,
  draggingIds: readonly string[],
  grouped: boolean,
): string | null {
  if (target.beforeId === null || !draggingIds.includes(target.beforeId)) return target.beforeId;
  const rows = [...document.querySelectorAll<HTMLElement>("[data-todo-row]")];
  const index = rows.findIndex((row) => row.dataset.todoId === target.beforeId);
  for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
    const candidate = rows[cursor]!;
    if (candidate.dataset.todoBucket !== target.bucket) return null;
    if (
      grouped &&
      ((candidate.dataset.todoList ?? "") !== target.listName ||
        (candidate.dataset.todoSection ?? "") !== target.sectionName)
    ) {
      return null;
    }
    const id = candidate.dataset.todoId;
    if (id && !draggingIds.includes(id)) return id;
  }
  return null;
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
      <path
        d="M8 3.25v9.5M3.25 8h9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className={className}>
      <path
        d="M2.5 6.25 5 8.75 9.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`h-3 w-3 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
    >
      <path
        d="m2.5 4.5 3.5 3.5 3.5-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3 w-3">
      <path d="M3.2 1.8v8.4L10 6 3.2 1.8Z" fill="currentColor" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3.5 w-3">
      <path
        d="M4 2.25h.01M8 2.25h.01M4 6h.01M8 6h.01M4 9.75h.01M8 9.75h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function checkStyle(color: TodoColor | null, checked: boolean): CSSProperties | undefined {
  if (!color) return undefined;
  const solid = COLOR_STYLE[color].solid;
  return checked
    ? { borderColor: solid, backgroundColor: solid, color: "#fff" }
    : { borderColor: solid, backgroundColor: "transparent", color: "transparent" };
}

/** Full session chips. Used in the inbox and inside an expanded row, never on the collapsed rail. */
function ThreadCapsules({ threads }: { threads: TodoThreadLink[] }) {
  const navigate = useBbNavigate();
  if (threads.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {threads.map((link) => (
        <button
          key={link.threadId}
          type="button"
          title={link.threadTitle || link.threadId}
          aria-label={`打开会话 ${threadLabel(link)}`}
          onClick={(event) => {
            event.stopPropagation();
            navigate.toThread(link.threadId);
          }}
          className="inline-flex max-w-full min-w-0 touch-manipulation cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              isRunningStatus(link.threadStatus) ? "animate-pulse bg-primary" : "bg-muted-foreground"
            }`}
          />
          <span className="truncate">{threadLabel(link)}</span>
        </button>
      ))}
    </div>
  );
}

function ThreadCountBadge({
  item,
  onShowThreads,
}: {
  item: TodoItem;
  onShowThreads(): void;
}) {
  const navigate = useBbNavigate();
  if (item.threads.length === 0) return null;
  const running = item.threads.some((link) => isRunningStatus(link.threadStatus));
  const single = item.threads.length === 1 ? item.threads[0] : null;
  const label = single ? `打开会话 ${threadLabel(single)}` : `查看 ${item.threads.length} 个关联会话`;
  return (
    <button
      type="button"
      title={item.threads.map((link) => threadLabel(link)).join("\n")}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        if (single) navigate.toThread(single.threadId);
        else onShowThreads();
      }}
      className="inline-flex h-6 touch-manipulation shrink-0 cursor-pointer appearance-none items-center gap-1 rounded-full border-0 bg-muted/70 px-1.5 text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          running ? "animate-pulse bg-primary" : "bg-muted-foreground"
        }`}
      />
      <span>{item.threads.length}</span>
    </button>
  );
}

function QuickAdd({
  inheritList,
  onAdded,
  onError,
}: {
  inheritList: string | null;
  onAdded(): void;
  onError(message: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [title, setTitle] = useState("");
  const [bucket, setBucket] = useState<TodoFormalBucket>("focus");
  const [adding, setAdding] = useState(false);
  const composing = useRef(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || adding) return;
    setAdding(true);
    const typedList = parseTitlePrefix(trimmed)?.listName;
    try {
      await rpc.call("quickAdd", {
        title: trimmed,
        bucket,
        ...(inheritList && !typedList ? { listName: inheritList } : {}),
      });
      setTitle("");
      onAdded();
    } catch {
      onError("没能添加这条待办，请再试一次。");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card px-2 py-1.5 shadow-sm transition-shadow focus-within:border-primary/40 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring">
      <div className="flex flex-nowrap items-center gap-1.5">
        <button
          type="button"
          aria-label="添加待办"
          title="添加待办"
          disabled={adding || title.trim().length === 0}
          onClick={() => void submit()}
          className="flex h-7 w-7 shrink-0 touch-manipulation cursor-pointer appearance-none items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
        >
          <PlusIcon />
        </button>
        <input
          aria-label="新待办标题"
          placeholder="添加一个待办，按 Enter 创建"
          value={title}
          maxLength={500}
          onChange={(event) => setTitle(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            if (composing.current || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
          className="min-w-0 flex-1 border-0 bg-transparent py-1 text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-sm"
        />
        <div className="relative shrink-0">
          <select
            aria-label="添加到分组"
            value={bucket}
            onChange={(event) => setBucket(event.target.value as TodoFormalBucket)}
            className="h-7 touch-manipulation cursor-pointer appearance-none rounded-full border-0 bg-muted pl-2.5 pr-5 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-xs"
          >
            {FORMAL_BUCKETS.map((value) => (
              <option key={value} value={value}>
                {BUCKET_LABEL[value]}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground">
            <ChevronIcon open={false} />
          </span>
        </div>
      </div>
    </div>
  );
}

type SuggestionTone = "complete" | "move" | "update" | "inbox";

function ActionTag({ label, tone }: { label: string; tone: SuggestionTone }) {
  const toneStyle: Record<SuggestionTone, CSSProperties> = {
    complete: { backgroundColor: "rgba(52,199,89,0.16)", color: "#248A3D" },
    move: { backgroundColor: "rgba(255,159,10,0.2)", color: "#9A5B00" },
    update: { backgroundColor: "rgba(0,122,255,0.14)", color: "#0A5FCC" },
    inbox: { backgroundColor: "rgba(88,86,214,0.16)", color: "#3F3DB8" },
  };
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-4"
      style={toneStyle[tone]}
    >
      {label}
    </span>
  );
}

function updatePreview(suggestion: TodoSuggestion): string | null {
  const parts: string[] = [];
  const patch = suggestion.patch;
  if (
    patch.bucket &&
    suggestion.currentBucket !== "inbox" &&
    patch.bucket !== suggestion.currentBucket
  ) {
    parts.push(`${BUCKET_LABEL[suggestion.currentBucket]} → ${BUCKET_LABEL[patch.bucket]}`);
  }
  if (patch.title) parts.push(`标题：${patch.title}`);
  if (patch.listName !== undefined || patch.sectionName !== undefined) {
    const list = patch.listName ?? suggestion.currentListName;
    const section = patch.sectionName ?? suggestion.currentSectionName;
    const place = [list, section].filter((part) => part.length > 0).join(" / ");
    parts.push(place.length > 0 ? `列表：${place}` : "列表：未归类");
  }
  if (patch.notesAppend) parts.push(`备注追加：${patch.notesAppend}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function belongsToList(currentList: string, nextList: string | undefined, filter: string | null): boolean {
  if (filter === null) return true;
  if (nextList !== undefined && nextList === filter) return true;
  return currentList === filter;
}

function SuggestionCard({
  suggestion,
  onChanged,
  onError,
}: {
  suggestion: TodoSuggestion;
  onChanged(): void;
  onError(message: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState<"accept" | "dismiss" | null>(null);
  const nextBucket = suggestion.patch.bucket;
  const moved =
    suggestion.kind === "update" &&
    nextBucket !== undefined &&
    nextBucket !== suggestion.currentBucket;
  const tag =
    suggestion.kind === "complete"
      ? { label: "建议完成", tone: "complete" as const }
      : moved && nextBucket
        ? { label: `移入 ${BUCKET_LABEL[nextBucket]}`, tone: "move" as const }
        : { label: "建议更新", tone: "update" as const };
  const preview = suggestion.kind === "update" ? updatePreview(suggestion) : null;

  const run = async (decision: "accept" | "dismiss") => {
    if (pending !== null) return;
    setPending(decision);
    try {
      await rpc.call("resolveSuggestion", { id: suggestion.id, decision });
      onChanged();
    } catch {
      onError(`没能处理 ${suggestion.id}，请再试一次。`);
    } finally {
      setPending(null);
    }
  };

  return (
    <li className="rounded-xl border border-border bg-background p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <ActionTag label={tag.label} tone={tag.tone} />
        <span className="min-w-0 text-sm font-medium break-words text-foreground">{suggestion.itemTitle}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{suggestion.id}</span>
      </div>
      {preview ? <p className="mt-1 text-xs text-muted-foreground">{preview}</p> : null}
      <p className="mt-2 text-sm leading-6 break-words whitespace-pre-wrap text-foreground">{suggestion.reason}</p>
      <div className="mt-2">
        <ThreadCapsules threads={suggestion.evidenceThreads} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void run("accept")}
          className={primaryButtonClassName}
        >
          采纳
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void run("dismiss")}
          className={quietButtonClassName}
        >
          忽略
        </button>
      </div>
    </li>
  );
}

function InboxRow({
  item,
  targets,
  onChanged,
  onError,
}: {
  item: TodoItem;
  targets: TodoItem[];
  onChanged(): void;
  onError(message: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [acceptBucket, setAcceptBucket] = useState<TodoFormalBucket>("focus");
  const [adjusting, setAdjusting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeInto, setMergeInto] = useState("");
  const [pending, setPending] = useState<"accept" | "merge" | "dismiss" | null>(null);

  const run = async (
    kind: "accept" | "merge" | "dismiss",
    input:
      | { id: string; action: "accept"; bucket: TodoFormalBucket }
      | { id: string; action: "merge"; intoId: string }
      | { id: string; action: "dismiss" },
  ) => {
    if (pending !== null) return;
    setPending(kind);
    try {
      await rpc.call("triageInbox", input);
      onChanged();
    } catch {
      onError(`没能处理 ${item.id}，请再试一次。`);
    } finally {
      setPending(null);
    }
  };

  const place = [item.listName, item.sectionName].filter((part) => part.length > 0).join("/");

  return (
    <li className="rounded-xl border border-border bg-background p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <ActionTag label="新增待办" tone="inbox" />
        <span className="min-w-0 text-sm font-medium break-words text-foreground">{item.title}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{item.id}</span>
        {place ? (
          <span className="inline-flex max-w-full truncate rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            #{place}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-sm leading-6 break-words whitespace-pre-wrap text-foreground">
        {item.proposalReason || "Agent 从最近的记录中提议"}
      </p>
      <div className="mt-2">
        <ThreadCapsules threads={item.threads} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void run("accept", { id: item.id, action: "accept", bucket: acceptBucket })}
          className={primaryButtonClassName}
        >
          采纳
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void run("dismiss", { id: item.id, action: "dismiss" })}
          className={quietButtonClassName}
        >
          忽略
        </button>
        <button
          type="button"
          aria-expanded={adjusting}
          disabled={pending !== null}
          onClick={() => {
            setAdjusting((value) => !value);
            if (merging) setMerging(false);
          }}
          className={quietButtonClassName}
        >
          调整
        </button>
      </div>
      {adjusting ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label={`采纳 ${item.id} 到分组`}
            value={acceptBucket}
            onChange={(event) => setAcceptBucket(event.target.value as TodoFormalBucket)}
            className="touch-manipulation cursor-pointer rounded-md border border-border bg-background px-2 py-1 text-base text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
          >
            {FORMAL_BUCKETS.map((bucket) => (
              <option key={bucket} value={bucket}>
                {BUCKET_LABEL[bucket]}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => {
              setMerging((value) => !value);
              setMergeInto(targets[0]?.id ?? "");
            }}
            className={quietButtonClassName}
          >
            并入
          </button>
        </div>
      ) : null}
      {merging ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2">
          <select
            aria-label={`并入目标 ${item.id}`}
            value={mergeInto}
            onChange={(event) => setMergeInto(event.target.value)}
            className="min-w-0 flex-1 touch-manipulation cursor-pointer rounded-md border border-border bg-background px-2 py-1 text-base text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
          >
            {targets.length === 0 ? <option value="">暂无正式待办可并入</option> : null}
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.id} {target.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending !== null || mergeInto.length === 0}
            onClick={() => {
              if (mergeInto.length === 0) return;
              void run("merge", { id: item.id, action: "merge", intoId: mergeInto });
            }}
            className={primaryButtonClassName}
          >
            确认并入
          </button>
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => setMerging(false)}
            className={quietButtonClassName}
          >
            取消
          </button>
        </div>
      ) : null}
    </li>
  );
}

function AgentSuggestionsSection({
  suggestions,
  inbox,
  listFilter,
  targets,
  onChanged,
  onError,
}: {
  suggestions: TodoSuggestion[];
  inbox: TodoItem[];
  listFilter: string | null;
  targets: TodoItem[];
  onChanged(): void;
  onError(message: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [acceptingAll, setAcceptingAll] = useState(false);
  const visibleSuggestions = suggestions.filter((suggestion) =>
    belongsToList(suggestion.currentListName, suggestion.patch.listName, listFilter),
  );
  const visibleInbox = inbox.filter((item) => belongsToList(item.listName, undefined, listFilter));
  const total = visibleSuggestions.length + visibleInbox.length;
  if (total === 0) return null;

  const acceptAll = async () => {
    if (acceptingAll) return;
    setAcceptingAll(true);
    try {
      await rpc.call("acceptAllSuggestions", {
        ids: [...visibleSuggestions.map((suggestion) => suggestion.id), ...visibleInbox.map((item) => item.id)],
      });
      onChanged();
    } catch {
      onError("没能全部采纳，请再试一次。");
    } finally {
      setAcceptingAll(false);
    }
  };

  return (
    <section
      aria-label="Agent 建议"
      className="space-y-2 rounded-2xl border border-border bg-card p-3 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 className="text-xs font-medium text-foreground">
          Agent 建议{" "}
          <span className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            {total}
          </span>
        </h2>
        {total >= 2 ? (
          <button
            type="button"
            disabled={acceptingAll}
            onClick={() => void acceptAll()}
            className={quietButtonClassName}
          >
            {acceptingAll ? "采纳中…" : "全部采纳"}
          </button>
        ) : null}
      </div>
      <ul className="space-y-2">
        {visibleSuggestions.map((suggestion) => (
          <SuggestionCard
            key={suggestion.id}
            suggestion={suggestion}
            onChanged={onChanged}
            onError={onError}
          />
        ))}
        {visibleInbox.map((item) => (
          <InboxRow key={item.id} item={item} targets={targets} onChanged={onChanged} onError={onError} />
        ))}
      </ul>
    </section>
  );
}

function StartSessionButton({
  item,
  onError,
  variant,
}: {
  item: TodoItem;
  onError(message: string): void;
  variant: "icon" | "label";
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);
  const carried = Math.min(item.threads.length, TODO_START_RELATED_LIMIT);
  const hint = carried > 0 ? `开启新会话并带入 ${carried} 个关联会话上下文` : "为此待办开启新会话";

  const start = async () => {
    if (pending) return;
    setPending(true);
    try {
      const prepared = await rpc.call("prepareStartSession", { id: item.id });
      navigate.toCompose({
        focusPrompt: true,
        initialPrompt: prepared.initialPrompt,
        ...(prepared.projectId ? { projectId: prepared.projectId } : {}),
        ...(prepared.environmentId ? { environmentId: prepared.environmentId } : {}),
      });
    } catch {
      onError(`没能为 ${item.id} 开启新会话。`);
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      title={hint}
      aria-label={`${hint}（${item.id}）`}
      disabled={pending}
      onClick={(event) => {
        event.stopPropagation();
        void start();
      }}
      className={
        variant === "icon"
          ? `${iconButtonClassName} opacity-100 sm:opacity-60 sm:group-hover:opacity-100`
          : "inline-flex shrink-0 touch-manipulation cursor-pointer items-center rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
      }
    >
      {pending ? (variant === "icon" ? "…" : "开启中…") : variant === "icon" ? <PlayIcon /> : "▶ 开启新会话"}
    </button>
  );
}

function LogEntry({ log }: { log: TodoLogEntry }) {
  const navigate = useBbNavigate();
  const threadId = log.threadId;
  return (
    <li className="rounded-lg border border-border bg-card px-2.5 py-2 text-xs">
      <p className="whitespace-pre-wrap break-words text-foreground">{log.text}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <time dateTime={log.createdAt}>{formatTime(log.createdAt)}</time>
        {threadId ? (
          <button
            type="button"
            aria-label={`打开进展会话 ${shortThreadId(threadId)}`}
            onClick={() => navigate.toThread(threadId)}
            className="touch-manipulation cursor-pointer rounded text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {shortThreadId(threadId)}
          </button>
        ) : null}
      </div>
    </li>
  );
}

function TodoDetails({
  item,
  listNames,
  hideNotes,
  onChanged,
  onError,
  onCollapse,
}: {
  item: TodoItem;
  listNames: string[];
  hideNotes: boolean;
  onChanged(): void;
  onError(message: string): void;
  onCollapse(): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [title, setTitle] = useState(item.title);
  const [bucket, setBucket] = useState<TodoFormalBucket>(item.bucket as TodoFormalBucket);
  const [notes, setNotes] = useState(item.notes);
  const [listName, setListName] = useState(item.listName);
  const [sectionName, setSectionName] = useState(item.sectionName);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [saved, setSaved] = useState(false);
  const baseline = useRef({
    title: item.title,
    bucket: item.bucket as TodoFormalBucket,
    notes: item.notes,
    listName: item.listName,
    sectionName: item.sectionName,
  });
  const seenId = useRef(item.id);
  const draftRef = useRef({ title, bucket, notes, listName, sectionName });
  draftRef.current = { title, bucket, notes, listName, sectionName };

  const draftIsDirty = (draft: typeof draftRef.current) =>
    draft.title.trim() !== baseline.current.title ||
    draft.bucket !== baseline.current.bucket ||
    draft.notes !== baseline.current.notes ||
    draft.listName.trim() !== baseline.current.listName ||
    draft.sectionName.trim() !== baseline.current.sectionName;

  useEffect(() => {
    const next = {
      title: item.title,
      bucket: item.bucket as TodoFormalBucket,
      notes: item.notes,
      listName: item.listName,
      sectionName: item.sectionName,
    };
    const idChanged = seenId.current !== item.id;
    seenId.current = item.id;
    if (idChanged) {
      baseline.current = next;
      setTitle(next.title);
      setBucket(next.bucket);
      setNotes(next.notes);
      setListName(next.listName);
      setSectionName(next.sectionName);
      setSaved(false);
      return;
    }
    if (draftIsDirty(draftRef.current)) return;
    const changed =
      next.title !== baseline.current.title ||
      next.bucket !== baseline.current.bucket ||
      next.notes !== baseline.current.notes ||
      next.listName !== baseline.current.listName ||
      next.sectionName !== baseline.current.sectionName;
    baseline.current = next;
    if (!changed) return;
    setTitle(next.title);
    setBucket(next.bucket);
    setNotes(next.notes);
    setListName(next.listName);
    setSectionName(next.sectionName);
    setSaved(false);
  }, [item.id, item.title, item.bucket, item.notes, item.listName, item.sectionName, item.updatedAt]);

  const dirty = draftIsDirty({ title, bucket, notes, listName, sectionName });

  const save = async () => {
    if (saving) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      onError("标题不能为空。");
      return;
    }
    const patch: {
      title?: string;
      bucket?: TodoFormalBucket;
      notes?: string;
      listName?: string;
      sectionName?: string;
    } = {};
    if (trimmedTitle !== baseline.current.title) patch.title = trimmedTitle;
    if (bucket !== baseline.current.bucket) patch.bucket = bucket;
    if (notes !== baseline.current.notes) patch.notes = notes;
    if (listName.trim() !== baseline.current.listName) patch.listName = listName.trim();
    if (sectionName.trim() !== baseline.current.sectionName) patch.sectionName = sectionName.trim();
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      await rpc.call("update", { id: item.id, ...patch });
      baseline.current = {
        title: trimmedTitle,
        bucket,
        notes,
        listName: listName.trim(),
        sectionName: sectionName.trim(),
      };
      setTitle(trimmedTitle);
      setListName(listName.trim());
      setSectionName(sectionName.trim());
      setSaved(true);
      onChanged();
    } catch {
      onError(`没能保存 ${item.id} 的修改。`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (removing) return;
    setRemoving(true);
    try {
      await rpc.call("remove", { id: item.id });
      onChanged();
      onCollapse();
    } catch {
      onError(`没能删除 ${item.id}。`);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div
      className="animate-in fade-in slide-in-from-top-1 duration-150"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void save();
        }
      }}
    >
      {hideNotes ? null : (
        <textarea
          aria-label={`备注 ${item.id}`}
          value={notes}
          rows={3}
          maxLength={20000}
          placeholder="添加备注"
          onChange={(event) => setNotes(event.target.value)}
          className="block max-h-[65dvh] min-h-10 w-full resize-y rounded-md border-0 bg-transparent px-1 py-1 text-base leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [field-sizing:content] sm:text-sm"
        />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" disabled={saving || !dirty} onClick={() => void save()} className={primaryButtonClassName}>
          {saving ? "保存中…" : "保存"}
        </button>
        <span className="text-xs text-muted-foreground">{saved && !dirty ? "已保存" : "⌘/Ctrl + Enter 保存"}</span>
        <StartSessionButton item={item} onError={onError} variant="label" />
      </div>
      <details className="mt-3 border-t border-border pt-1">
        <summary className="cursor-pointer rounded-sm py-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          更多详情 <span className="ml-1 tabular-nums">{item.id}</span>
        </summary>
        <div className="pt-2">
          <div className="grid gap-2 md:grid-cols-2">
            <label className="space-y-1 md:col-span-2">
              <span className="text-xs text-muted-foreground">标题</span>
              <input
                aria-label={`标题 ${item.id}`}
                value={title}
                maxLength={500}
                onChange={(event) => setTitle(event.target.value)}
                className={fieldClassName}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">分组</span>
              <select
                aria-label={`分组 ${item.id}`}
                value={bucket}
                onChange={(event) => setBucket(event.target.value as TodoFormalBucket)}
                className={`${fieldClassName} cursor-pointer`}
              >
                {FORMAL_BUCKETS.map((value) => (
                  <option key={value} value={value}>
                    {BUCKET_LABEL[value]} · {BUCKET_CAPTION[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">项目列表</span>
              <input
                aria-label={`项目列表 ${item.id}`}
                value={listName}
                maxLength={80}
                list="todo-list-names"
                placeholder="例如 LightSpace"
                onChange={(event) => setListName(event.target.value)}
                className={fieldClassName}
              />
            </label>
            <label className="space-y-1 md:col-span-2">
              <span className="text-xs text-muted-foreground">子分组（Section）</span>
              <input
                aria-label={`分组（Section） ${item.id}`}
                value={sectionName}
                maxLength={80}
                placeholder="列表内的子分组"
                onChange={(event) => setSectionName(event.target.value)}
                className={fieldClassName}
              />
            </label>
          </div>
          <datalist id="todo-list-names">
            {listNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {item.threads.length > 0 ? (
            <div className="mt-3 space-y-1">
              <h3 className="text-xs font-medium text-muted-foreground">关联会话</h3>
              <ThreadCapsules threads={item.threads} />
            </div>
          ) : null}
          <div className="mt-3 space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">进展日志</h3>
            {item.logs.length === 0 ? (
              <p className="text-xs text-muted-foreground">Agent 还没有留下日志。</p>
            ) : (
              <ul className="max-h-52 space-y-2 overflow-y-auto pr-1">
                {item.logs.map((log) => (
                  <LogEntry key={log.id} log={log} />
                ))}
              </ul>
            )}
          </div>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              disabled={saving || removing}
              onClick={() => void remove()}
              aria-label={`删除 ${item.id}`}
              className="touch-manipulation cursor-pointer rounded-md px-2 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              删除
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}

function TodoRow({
  item,
  lists,
  showListChip,
  hasSuggestion,
  expanded,
  divider,
  selected,
  dragging,
  dropBefore,
  onToggle,
  onShowThreads,
  onInsertAfter,
  onRangeSelect,
  onDragStart,
  onChanged,
  onError,
}: {
  item: TodoItem;
  lists: TodoListSummary[];
  showListChip: boolean;
  hasSuggestion: boolean;
  expanded: boolean;
  divider: boolean;
  selected: boolean;
  dragging: boolean;
  dropBefore: boolean;
  onToggle(): void;
  onShowThreads(): void;
  onInsertAfter(): void;
  onRangeSelect(id: string, event: ReactMouseEvent): void;
  onDragStart(item: TodoItem, event: ReactPointerEvent<HTMLButtonElement>): void;
  onChanged(): void;
  onError(message: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [pendingCompleted, setPendingCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(item.title);
  const [draftNotes, setDraftNotes] = useState(item.notes);
  const [optimisticTitle, setOptimisticTitle] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const notesInputRef = useRef<HTMLTextAreaElement | null>(null);
  const titleComposing = useRef(false);
  const notesComposing = useRef(false);
  const titleEditSettled = useRef(false);
  const movingWithinEditor = useRef(false);
  const detailsId = `todo-details-${item.id}`;
  const completed = item.completedAt !== null;
  const checked = completed || pendingCompleted;
  const color = colorOf(lists, item.listName);
  const listNames = lists.map((list) => list.name);

  useEffect(() => {
    // A realtime refresh or the post-save snapshot now owns the title.
    setOptimisticTitle(null);
  }, [item.title]);

  useEffect(() => {
    if (editingTitle) return;
    setDraftNotes(item.notes);
  }, [editingTitle, item.notes]);

  const resizeTitleInput = () => {
    const element = titleInputRef.current;
    if (!element) return;
    element.style.height = "auto";
    const nextHeight = element.scrollHeight;
    element.style.height = nextHeight > 0 ? `${nextHeight}px` : "";
  };

  useEffect(() => {
    if (!editingTitle) return;
    const element = titleInputRef.current;
    if (!element) return;
    element.focus();
    const end = element.value.length;
    element.setSelectionRange(end, end);
    resizeTitleInput();
  }, [editingTitle]);

  useEffect(() => {
    if (editingTitle) resizeTitleInput();
  }, [draftTitle, editingTitle]);

  const resizeNotesInput = () => {
    const element = notesInputRef.current;
    if (!element) return;
    element.style.height = "auto";
    const nextHeight = element.scrollHeight;
    element.style.height = nextHeight > 0 ? `${nextHeight}px` : "";
  };

  useEffect(() => {
    if (editingTitle) resizeNotesInput();
  }, [draftNotes, editingTitle]);

  const focusNotes = () => {
    const element = notesInputRef.current;
    if (!element) return;
    movingWithinEditor.current = true;
    element.focus();
    element.setSelectionRange(0, element.value.length);
    movingWithinEditor.current = false;
  };

  const focusTitle = () => {
    const element = titleInputRef.current;
    if (!element) return;
    movingWithinEditor.current = true;
    element.focus();
    const end = element.value.length;
    element.setSelectionRange(end, end);
    movingWithinEditor.current = false;
  };

  const editorKeepsFocus = (next: EventTarget | null) =>
    next === titleInputRef.current || next === notesInputRef.current;

  const beginTitleEdit = () => {
    titleEditSettled.current = false;
    titleComposing.current = false;
    notesComposing.current = false;
    setDraftTitle(item.title);
    setDraftNotes(item.notes);
    setEditingTitle(true);
  };

  const finishEditing = () => {
    if (titleEditSettled.current) return;
    titleEditSettled.current = true;
    const trimmed = draftTitle.trim();
    const titleChanged = trimmed.length > 0 && trimmed !== item.title;
    const notesChanged = draftNotes !== item.notes;
    setEditingTitle(false);
    if (!titleChanged && !notesChanged) {
      setDraftTitle(item.title);
      setDraftNotes(item.notes);
      return;
    }
    if (trimmed.length === 0) setDraftTitle(item.title);
    if (titleChanged) setOptimisticTitle(trimmed);
    void rpc
      .call("update", {
        id: item.id,
        ...(titleChanged ? { title: trimmed } : {}),
        ...(notesChanged ? { notes: draftNotes } : {}),
      })
      .then(
        () => {
          onChanged();
        },
        () => {
          setOptimisticTitle(null);
          onError(`没能保存 ${item.id}。`);
        },
      );
  };

  const cancelTitleEdit = () => {
    titleEditSettled.current = true;
    setDraftTitle(item.title);
    setDraftNotes(item.notes);
    setEditingTitle(false);
    titleInputRef.current?.blur();
  };

  const onEditorBlur = (event: ReactFocusEvent<HTMLTextAreaElement>) => {
    if (movingWithinEditor.current || editorKeepsFocus(event.relatedTarget)) return;
    finishEditing();
  };

  const onTitleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that confirms an IME candidate belongs to the IME, never to save.
    if (titleComposing.current || event.nativeEvent.isComposing) return;
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      focusNotes();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelTitleEdit();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    finishEditing();
    onInsertAfter();
  };

  const onNotesKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (notesComposing.current || event.nativeEvent.isComposing) return;
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      focusTitle();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelTitleEdit();
    }
  };

  const toggleCompleted = async () => {
    if (busy) return;
    setBusy(true);
    setPendingCompleted(true);
    try {
      await rpc.call("setCompleted", { id: item.id, completed: true });
      onChanged();
    } catch {
      setPendingCompleted(false);
      onError(`没能完成 ${item.id}。`);
    } finally {
      setBusy(false);
    }
  };

  const modifierSelect = (event: ReactMouseEvent) =>
    event.shiftKey || event.metaKey || event.ctrlKey;

  const onSurfaceClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (modifierSelect(event)) {
      onRangeSelect(item.id, event);
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea, label")) return;
    onToggle();
  };

  return (
    <div
      className={divider ? "border-t border-border" : undefined}
      data-todo-row
      data-todo-id={item.id}
      data-todo-bucket={item.bucket}
      data-todo-list={item.listName}
      data-todo-section={item.sectionName}
      data-selected={selected ? "true" : "false"}
      aria-selected={selected}
      title={`${item.id} ${item.title}`}
    >
      {dropBefore ? <div aria-hidden="true" className="h-0.5 bg-primary" /> : null}
      <div
        onClick={onSurfaceClick}
        className={`group flex items-start gap-1.5 px-2 pt-2.5 transition-colors sm:px-2.5 ${
          expanded ? "bg-card" : selected ? "bg-accent pb-2.5" : "pb-2.5 hover:bg-accent"
        } ${dragging ? "opacity-40" : ""}`}
      >
        <div className="flex h-5 shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label={`拖动 ${item.id}`}
            title="拖动调整位置"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              onDragStart(item, event);
            }}
            onClick={(event) => event.stopPropagation()}
            style={{ marginTop: 0, padding: 0, height: "1rem", width: "1rem" }}
            className="flex h-4 w-4 shrink-0 touch-none cursor-grab appearance-none items-center justify-center rounded border-0 bg-transparent p-0 text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          >
            <GripIcon />
          </button>
          <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={`完成 ${item.id}`}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              if (modifierSelect(event)) {
                onRangeSelect(item.id, event);
                return;
              }
              void toggleCompleted();
            }}
            style={{ ...(checkStyle(color, checked) ?? {}), marginTop: 0, padding: 0, height: "1rem", width: "1rem" }}
            className={`flex h-4 w-4 shrink-0 touch-manipulation cursor-pointer appearance-none items-center justify-center rounded-full border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${
              color
                ? ""
                : checked
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground bg-transparent text-transparent hover:border-primary"
            }`}
          >
            <CheckIcon className="h-2.5 w-2.5" />
          </button>
        </div>
        <div className="min-w-0 flex-1" data-todo-main>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            {editingTitle ? (
              <textarea
                ref={titleInputRef}
                aria-label={`编辑标题 ${item.id}`}
                rows={1}
                value={draftTitle}
                maxLength={500}
                onChange={(event) => setDraftTitle(event.target.value)}
                onCompositionStart={() => {
                  titleComposing.current = true;
                }}
                onCompositionEnd={() => {
                  titleComposing.current = false;
                }}
                onKeyDown={onTitleKeyDown}
                onBlur={onEditorBlur}
                className="block min-w-0 flex-1 resize-none overflow-hidden rounded-none border-0 border-b border-primary/35 bg-transparent p-0 text-base font-medium leading-5 text-foreground outline-none transition-colors focus:border-primary focus:bg-muted/30 focus:outline-none sm:text-sm"
              />
            ) : (
              <button
                type="button"
                data-todo-title
                title={`${item.id} ${item.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (modifierSelect(event)) {
                    onRangeSelect(item.id, event);
                    return;
                  }
                  beginTitleEdit();
                }}
                style={{ padding: 0, lineHeight: "1.25rem" }}
                className="min-w-0 max-w-full touch-manipulation cursor-text appearance-none break-words border-0 bg-transparent p-0 text-left text-sm font-medium leading-5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {optimisticTitle ?? item.title}
              </button>
            )}
            {hasSuggestion ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground" style={{ backgroundColor: "rgba(255,159,10,0.16)" }}>
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "#FF9F0A" }} />
                有建议
              </span>
            ) : null}
            {showListChip && item.listName ? (
              <span
                className="inline-flex max-w-full shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground"
                style={color ? { backgroundColor: COLOR_STYLE[color].soft } : undefined}
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={color ? { backgroundColor: COLOR_STYLE[color].solid } : undefined}
                />
                <span className="truncate">{item.listName}</span>
              </span>
            ) : null}
          </div>
          {editingTitle ? (
            <textarea
              ref={notesInputRef}
              aria-label={`编辑备注 ${item.id}`}
              rows={1}
              value={draftNotes}
              maxLength={20000}
              placeholder="添加备注"
              onChange={(event) => setDraftNotes(event.target.value)}
              onCompositionStart={() => {
                notesComposing.current = true;
              }}
              onCompositionEnd={() => {
                notesComposing.current = false;
              }}
              onKeyDown={onNotesKeyDown}
              onBlur={onEditorBlur}
              className="mt-0.5 block min-w-0 w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-sm leading-5 text-muted-foreground outline-none placeholder:text-muted-foreground/50"
            />
          ) : !expanded && item.notes.trim() ? (
            <p className="line-clamp-2 whitespace-pre-line break-words text-sm leading-5 text-muted-foreground">
              {item.notes}
            </p>
          ) : null}
        </div>
        <div className="flex h-5 shrink-0 items-center gap-0.5" data-todo-rail>
          <ThreadCountBadge item={item} onShowThreads={onShowThreads} />
          {item.completedAt === null ? (
            <StartSessionButton item={item} onError={onError} variant="icon" />
          ) : null}
          <button
            type="button"
            aria-label={expanded ? `收起 ${item.id} 详情` : `展开 ${item.id} 详情`}
            aria-expanded={expanded}
            aria-controls={expanded ? detailsId : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            className={iconButtonClassName}
          >
            <ChevronIcon open={expanded} />
          </button>
        </div>
      </div>
      {expanded ? (
        <div id={detailsId} className="bg-card pb-2 pl-10 pr-2.5 sm:pl-11 sm:pr-3.5">
          <TodoDetails
            item={item}
            listNames={listNames}
            hideNotes={editingTitle}
            onChanged={onChanged}
            onError={onError}
            onCollapse={onToggle}
          />
        </div>
      ) : null}
    </div>
  );
}

function ListHeading({ name, color }: { name: string; color: TodoColor | null }) {
  const label = name.length > 0 ? name : "未归类";
  return (
    <div className="flex items-center gap-2 px-2.5 pt-2">
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={color ? { backgroundColor: COLOR_STYLE[color].solid } : { backgroundColor: "var(--muted-foreground)" }}
      />
      <h3 className="text-[13px] font-semibold text-foreground">{label}</h3>
    </div>
  );
}

function SectionHeading({
  sectionName,
  count,
  color,
  collapsed,
  dropEnd,
  bucket,
  listName,
  onToggle,
}: {
  sectionName: string;
  count: number;
  color: TodoColor | null;
  collapsed: boolean;
  dropEnd: boolean;
  bucket: TodoFormalBucket;
  listName: string;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      {...(collapsed
        ? {
            "data-todo-drop-end": "",
            "data-todo-bucket": bucket,
            "data-todo-list": listName,
            "data-todo-section": sectionName,
          }
        : {})}
      className={`flex w-full touch-manipulation cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        dropEnd ? "shadow-[inset_0_-2px_0_0_var(--primary)]" : ""
      }`}
    >
      <ChevronIcon open={!collapsed} />
      <span
        className="min-w-0 truncate text-xs font-semibold"
        style={color ? { color: COLOR_STYLE[color].solid } : undefined}
      >
        {sectionName}
      </span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

type InlineInsertTarget =
  | {
      kind: "after";
      afterId: string;
      bucket: TodoFormalBucket;
      listName: string;
      sectionName: string;
    }
  | {
      kind: "bottom";
      key: string;
      afterId?: string;
      bucket: TodoFormalBucket;
      listName: string;
      sectionName: string;
    };

function BottomInsertRow({
  divider,
  label,
  bucket,
  listName,
  sectionName,
  dropEnd,
  onActivate,
}: {
  divider: boolean;
  label: string;
  bucket: TodoFormalBucket;
  listName: string;
  sectionName: string;
  dropEnd: boolean;
  onActivate(): void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-todo-drop-end=""
      data-todo-bucket={bucket}
      data-todo-list={listName}
      data-todo-section={sectionName}
      onClick={onActivate}
      className={`group flex w-full touch-manipulation cursor-text appearance-none items-center gap-2.5 bg-transparent px-2.5 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3.5 ${
        divider ? "border-t border-border" : ""
      } ${dropEnd ? "shadow-[inset_0_2px_0_0_var(--primary)]" : ""}`}
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 shrink-0 rounded-full border border-dashed border-muted-foreground/50 transition-colors group-hover:border-muted-foreground"
      />
      <span className="text-sm leading-5 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        新建待办
      </span>
    </button>
  );
}

function InlineTodoDraftRow({
  bucket,
  listName,
  sectionName,
  afterId,
  color,
  divider,
  onSubmitted,
  onCancel,
  onError,
}: {
  bucket: TodoFormalBucket;
  listName: string;
  sectionName: string;
  afterId?: string;
  color: TodoColor | null;
  divider: boolean;
  onSubmitted(created: TodoItem): void;
  onCancel(): void;
  onError(message: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const settled = useRef(false);
  const submitting = useRef(false);

  const resize = () => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    const nextHeight = element.scrollHeight;
    element.style.height = nextHeight > 0 ? `${nextHeight}px` : "";
  };

  useEffect(() => {
    settled.current = false;
    const element = inputRef.current;
    if (!element) return;
    element.focus();
    resize();
  }, [afterId]);

  useEffect(() => {
    resize();
  }, [draft]);

  const submit = async (keepOpen: boolean) => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      settled.current = true;
      onCancel();
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    const typedPrefix = parseTitlePrefix(trimmed);
    try {
      const created = await rpc.call("quickAdd", {
        title: trimmed,
        bucket,
        ...(listName && !typedPrefix?.listName ? { listName } : {}),
        ...(sectionName && !typedPrefix?.listName ? { sectionName } : {}),
        ...(afterId ? { afterId } : {}),
      });
      setDraft("");
      onSubmitted(created);
      if (!keepOpen) {
        settled.current = true;
        onCancel();
      } else {
        inputRef.current?.focus();
      }
    } catch {
      onError("没能添加这条待办，请再试一次。");
    } finally {
      submitting.current = false;
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      settled.current = true;
      onCancel();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void submit(true);
  };

  return (
    <div
      data-todo-inline-draft
      className={`flex items-start gap-2.5 bg-card px-2.5 py-2.5 sm:px-3.5 ${
        divider ? "border-t border-border" : ""
      }`}
    >
      <span
        aria-hidden="true"
        style={{ ...(checkStyle(color, false) ?? {}), height: "1rem", width: "1rem" }}
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          color ? "" : "border-muted-foreground"
        }`}
      />
      <div className="min-w-0 flex-1">
        <textarea
          ref={inputRef}
          aria-label="插入新待办"
          placeholder="新待办"
          rows={1}
          value={draft}
          maxLength={500}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (settled.current || submitting.current) return;
            void submit(false);
          }}
          className="block min-w-0 w-full resize-none overflow-hidden rounded-none border-0 bg-transparent p-0 text-base font-medium leading-5 text-foreground outline-none placeholder:text-muted-foreground/60 sm:text-sm"
        />
      </div>
    </div>
  );
}

function TodoSection({
  bucket,
  items,
  lists,
  listFilter,
  groupByList,
  collapsedSections,
  suggestedItemIds,
  expandedId,
  inlineInsert,
  selectedIds,
  draggingIds,
  dropTarget,
  onToggleSection,
  onToggle,
  onShowThreads,
  onRangeSelect,
  onDragStart,
  onStartInlineAfter,
  onStartInlineBottom,
  onInlineSubmitted,
  onInlineCancel,
  onChanged,
  onError,
}: {
  bucket: TodoFormalBucket;
  items: TodoItem[];
  lists: TodoListSummary[];
  listFilter: string | null;
  groupByList: boolean;
  collapsedSections: ReadonlySet<string>;
  suggestedItemIds: ReadonlySet<string>;
  expandedId: string | null;
  inlineInsert: InlineInsertTarget | null;
  selectedIds: ReadonlySet<string>;
  draggingIds: ReadonlySet<string>;
  dropTarget: DropTarget | null;
  onToggleSection(key: string): void;
  onToggle(id: string): void;
  onShowThreads(id: string): void;
  onRangeSelect(id: string, event: ReactMouseEvent): void;
  onDragStart(item: TodoItem, event: ReactPointerEvent<HTMLButtonElement>): void;
  onStartInlineAfter(item: TodoItem): void;
  onStartInlineBottom(
    key: string,
    bucket: TodoFormalBucket,
    listName: string,
    sectionName: string,
    afterId?: string,
  ): void;
  onInlineSubmitted(created: TodoItem): void;
  onInlineCancel(): void;
  onChanged(): void;
  onError(message: string): void;
}) {
  const visible = items.filter((item) => listFilter === null || item.listName === listFilter);
  if (visible.length === 0) return null;
  const grouped = listFilter !== null || groupByList;
  const showListHeaders = groupByList && listFilter === null;
  const showChip = listFilter === null && !groupByList;

  const listOrder = showListHeaders
    ? [...new Set(visible.map((item) => item.listName))]
    : [listFilter ?? ""];

  const renderInlineAfter = (item: TodoItem) => {
    if (inlineInsert?.kind !== "after" || inlineInsert.afterId !== item.id) return null;
    return (
      <InlineTodoDraftRow
        key={`after-${item.id}`}
        bucket={inlineInsert.bucket}
        listName={inlineInsert.listName}
        sectionName={inlineInsert.sectionName}
        afterId={inlineInsert.afterId}
        color={colorOf(lists, inlineInsert.listName)}
        divider
        onSubmitted={onInlineSubmitted}
        onCancel={onInlineCancel}
        onError={onError}
      />
    );
  };

  const renderRows = (rows: TodoItem[], offset: number) =>
    rows.flatMap((item, index) => [
      <TodoRow
        key={item.id}
        item={item}
        lists={lists}
        showListChip={showChip}
        hasSuggestion={suggestedItemIds.has(item.id)}
        divider={offset + index > 0}
        expanded={expandedId === item.id}
        selected={selectedIds.has(item.id)}
        dragging={draggingIds.has(item.id)}
        dropBefore={
          dropTarget !== null &&
          dropTarget.beforeId === item.id &&
          sameDropGroup(dropTarget, item.bucket, item.listName, item.sectionName) &&
          !draggingIds.has(item.id)
        }
        onToggle={() => onToggle(item.id)}
        onShowThreads={() => onShowThreads(item.id)}
        onInsertAfter={() => onStartInlineAfter(item)}
        onRangeSelect={onRangeSelect}
        onDragStart={onDragStart}
        onChanged={onChanged}
        onError={onError}
      />,
      renderInlineAfter(item),
    ]);

  const renderBottomSlot = (
    groupKey: string,
    listName: string,
    sectionName: string,
    lastItem: TodoItem | undefined,
    divider: boolean,
  ) => {
    const color = colorOf(lists, listName);
    if (inlineInsert?.kind === "bottom" && inlineInsert.key === groupKey) {
      return (
        <InlineTodoDraftRow
          key={groupKey}
          bucket={inlineInsert.bucket}
          listName={inlineInsert.listName}
          sectionName={inlineInsert.sectionName}
          afterId={inlineInsert.afterId}
          color={color}
          divider={divider}
          onSubmitted={onInlineSubmitted}
          onCancel={onInlineCancel}
          onError={onError}
        />
      );
    }
    return (
      <BottomInsertRow
        key={`bottom-${groupKey}`}
        divider={divider}
        label="在底部添加待办"
        bucket={bucket}
        listName={listName}
        sectionName={sectionName}
        dropEnd={
          dropTarget !== null &&
          dropTarget.beforeId === null &&
          sameDropGroup(dropTarget, bucket, listName, sectionName)
        }
        onActivate={() => onStartInlineBottom(groupKey, bucket, listName, sectionName, lastItem?.id)}
      />
    );
  };

  let rendered = 0;
  const body = grouped
    ? listOrder.map((listName) => {
        const inList = showListHeaders ? visible.filter((item) => item.listName === listName) : visible;
        const loose = inList.filter((item) => item.sectionName.length === 0);
        const sectionNames = [...new Set(inList.map((item) => item.sectionName).filter((name) => name.length > 0))];
        const color = colorOf(lists, listName);
        const looseStart = rendered;
        rendered += loose.length;
        return (
          <div key={listName || "loose"}>
            {showListHeaders ? <ListHeading name={listName} color={color} /> : null}
            {renderRows(loose, looseStart)}
            {loose.length > 0
              ? renderBottomSlot(`${bucket}\0${listName}\0`, listName, "", loose[loose.length - 1], true)
              : null}
            {sectionNames.map((sectionName) => {
              const key = `${listName}\0${sectionName}`;
              const rows = inList.filter((item) => item.sectionName === sectionName);
              const collapsed = collapsedSections.has(key);
              const start = rendered;
              rendered += rows.length;
              return (
                <div key={key}>
                  <SectionHeading
                    sectionName={sectionName}
                    count={rows.length}
                    color={color}
                    collapsed={collapsed}
                    bucket={bucket}
                    listName={listName}
                    dropEnd={
                      collapsed &&
                      dropTarget !== null &&
                      dropTarget.beforeId === null &&
                      sameDropGroup(dropTarget, bucket, listName, sectionName)
                    }
                    onToggle={() => onToggleSection(key)}
                  />
                  {collapsed ? null : (
                    <>
                      {renderRows(rows, start)}
                      {renderBottomSlot(
                        `${bucket}\0${listName}\0${sectionName}`,
                        listName,
                        sectionName,
                        rows[rows.length - 1],
                        true,
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })
    : [
        ...renderRows(visible, 0),
        renderBottomSlot(`${bucket}\0\0`, "", "", visible[visible.length - 1], visible.length > 0),
      ];

  return (
    <section aria-label={`${BUCKET_LABEL[bucket]} 待办`} className="space-y-2">
      <div className="flex items-baseline gap-2 px-2">
        <h2 className="text-[13px] font-semibold text-foreground">{BUCKET_LABEL[bucket]}</h2>
        <span className="text-[11px] tabular-nums text-muted-foreground">{visible.length}</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">{body}</div>
    </section>
  );
}

function DoneRow({
  item,
  lists,
  divider,
  onChanged,
  onError,
}: {
  item: TodoItem;
  lists: TodoListSummary[];
  divider: boolean;
  onChanged(): void;
  onError(message: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [pendingRestore, setPendingRestore] = useState(false);
  const color = colorOf(lists, item.listName);
  if (pendingRestore) return null;

  const restore = async () => {
    if (busy) return;
    setBusy(true);
    setPendingRestore(true);
    try {
      await rpc.call("setCompleted", { id: item.id, completed: false });
      onChanged();
    } catch {
      setPendingRestore(false);
      onError(`没能恢复 ${item.id}。`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`flex items-start gap-2 px-2.5 py-2 sm:px-3.5 ${divider ? "border-t border-border" : ""}`}>
      <button
        type="button"
        role="checkbox"
        aria-checked="true"
        aria-label={`恢复 ${item.id}`}
        disabled={busy}
        onClick={() => void restore()}
        style={{ ...(checkStyle(color, true) ?? {}), height: "1rem", width: "1rem" }}
        className={`mt-0.5 flex h-4 w-4 shrink-0 touch-manipulation cursor-pointer items-center justify-center rounded-full border text-primary-foreground transition-all duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${
          color ? "" : "border-primary bg-primary"
        }`}
      >
        <CheckIcon className="h-2.5 w-2.5" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm text-muted-foreground">{item.title}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {item.completedAt ? <time dateTime={item.completedAt}>{formatTime(item.completedAt)}</time> : null}
        </div>
      </div>
    </div>
  );
}

function CompletedSection({
  items,
  count,
  lists,
  expanded,
  onToggleExpanded,
  onChanged,
  onError,
}: {
  items: TodoItem[];
  count: number;
  lists: TodoListSummary[];
  expanded: boolean;
  onToggleExpanded(): void;
  onChanged(): void;
  onError(message: string): void;
}) {
  return (
    <section className="pt-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggleExpanded}
        className="flex w-full touch-manipulation cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-2">
          <ChevronIcon open={expanded} />
          已完成
        </span>
        <span className="tabular-nums">{count}</span>
      </button>
      {expanded ? (
        <div className="animate-in fade-in slide-in-from-top-1 mt-1 overflow-hidden rounded-2xl border border-border bg-card duration-150">
          {items.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">还没有完成项。</div>
          ) : (
            items.map((item, index) => (
              <DoneRow
                key={item.id}
                item={item}
                lists={lists}
                divider={index > 0}
                onChanged={onChanged}
                onError={onError}
              />
            ))
          )}
          {count > items.length ? (
            <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              仅显示最近 {items.length} 项
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function HistorySection({
  refreshToken,
  onChanged,
  onError,
}: {
  refreshToken: number;
  onChanged(): void;
  onError(message: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TodoRevision[] | null>(null);
  const [pendingRev, setPendingRev] = useState<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("listRevisions", { limit: 20 });
      if (mounted.current) setRows(result.revisions);
    } catch {
      if (mounted.current) onError("没能加载最近变更。");
    }
  }, [onError, rpc]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open, refreshToken]);

  const undo = async (rev: number) => {
    if (pendingRev !== null) return;
    setPendingRev(rev);
    try {
      await rpc.call("undoRevision", { rev });
      onChanged();
      await load();
    } catch {
      onError("没能撤销这次变更。");
    } finally {
      setPendingRev(null);
    }
  };

  return (
    <section className="pt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full touch-manipulation cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-2">
          <ChevronIcon open={open} />
          最近变更（可撤销）
        </span>
      </button>
      {open ? (
        <ul className="mt-1 overflow-hidden rounded-2xl border border-border bg-card">
          {rows === null ? (
            <li className="px-3 py-3 text-xs text-muted-foreground">加载中…</li>
          ) : rows.length === 0 ? (
            <li className="px-3 py-3 text-xs text-muted-foreground">还没有变更。</li>
          ) : (
            rows.map((revision, index) => {
              const canUndo = revision.undoneAt === null && revision.action !== "undo";
              return (
                <li
                  key={revision.rev}
                  className={`flex items-start gap-2 px-2.5 py-2 sm:px-3.5 ${index > 0 ? "border-t border-border" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-xs text-foreground">{revision.summary}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      <time dateTime={revision.createdAt}>{formatTime(revision.createdAt)}</time>
                      <span> · {actorLabel(revision.actor)}</span>
                      {revision.undoneAt ? <span> · 已撤销</span> : null}
                    </p>
                  </div>
                  {canUndo ? (
                    <button
                      type="button"
                      disabled={pendingRev !== null}
                      aria-label={`撤销 ${revision.summary}`}
                      onClick={() => void undo(revision.rev)}
                      className={quietButtonClassName}
                    >
                      {pendingRev === revision.rev ? "撤销中…" : "撤销"}
                    </button>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </section>
  );
}

function ListBar({
  lists,
  uncategorized,
  total,
  selected,
  groupByList,
  onSelect,
  onToggleGroup,
  onRecolor,
}: {
  lists: TodoListSummary[];
  uncategorized: number;
  total: number;
  selected: string | null;
  groupByList: boolean;
  onSelect(next: string | null): void;
  onToggleGroup(): void;
  onRecolor(listName: string, color: TodoColor): void;
}) {
  const [paletteFor, setPaletteFor] = useState<string | null>(null);
  const selectedList = selected && selected.length > 0 ? lists.find((list) => list.name === selected) : undefined;

  const capsule = (name: string, count: number, value: string | null, color: TodoColor | null) => {
    const active = selected === value;
    const style: CSSProperties | undefined =
      active && color
        ? {
            backgroundColor: COLOR_STYLE[color].soft,
            borderColor: COLOR_STYLE[color].solid,
          }
        : undefined;
    return (
      <button
        key={name}
        type="button"
        aria-pressed={active}
        onClick={() => onSelect(value)}
        style={style}
        className={`inline-flex touch-manipulation cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          active ? "text-foreground" : "border-border text-muted-foreground hover:text-foreground"
        }`}
      >
        {color ? (
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: COLOR_STYLE[color].solid }}
          />
        ) : null}
        <span>{name}</span>
        <span className="tabular-nums">{count}</span>
      </button>
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {capsule("全部", total, null, null)}
      {lists.map((list) => capsule(list.name, list.openCount, list.name, list.color))}
      {uncategorized > 0 ? capsule("未归类", uncategorized, "", null) : null}
      {selectedList ? (
        <span className="relative inline-flex items-center">
          <button
            type="button"
            aria-label={`更换 ${selectedList.name} 的颜色`}
            title="更换颜色"
            onClick={() => setPaletteFor((current) => (current === selectedList.name ? null : selectedList.name))}
            className="h-4 w-4 touch-manipulation cursor-pointer rounded-full border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ backgroundColor: COLOR_STYLE[selectedList.color].solid }}
          />
          {paletteFor === selectedList.name ? (
            <span
              role="listbox"
              aria-label={`${selectedList.name} 的颜色`}
              className="absolute top-6 left-0 z-10 flex gap-1 rounded-full border border-border bg-card p-1 shadow-sm"
            >
              {TODO_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="option"
                  aria-selected={color === selectedList.color}
                  aria-label={`颜色 ${color}`}
                  onClick={() => {
                    onRecolor(selectedList.name, color);
                    setPaletteFor(null);
                  }}
                  className="h-4 w-4 touch-manipulation cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{ backgroundColor: COLOR_STYLE[color].solid }}
                />
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
      <button
        type="button"
        aria-pressed={groupByList}
        title={groupByList ? "改为平铺列表" : "按项目分组"}
        onClick={onToggleGroup}
        className={`${quietButtonClassName} ${
          groupByList ? "bg-muted text-foreground" : ""
        }`}
      >
        按项目分组
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="py-10 text-center">
      <p className="text-sm text-muted-foreground">还没有待办。</p>
      <p className="mt-1 text-xs text-muted-foreground">敲一行标题，按 Enter 开始。</p>
    </div>
  );
}

function useTodoBadge(): ExperimentalBadge | null {
  const rpc = useRpc<typeof rpcContract>();
  const [counts, setCounts] = useState<TodoCounts | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const snapshot = await rpc.call("listSnapshot", {});
      if (mounted.current) setCounts(snapshot.counts);
    } catch {
      if (mounted.current) setCounts(null);
    }
  }, [rpc]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  useRealtime(TODO_CHANGED_EVENT, () => {
    void load();
  });

  try {
    if (counts === null) return null;
    const inbox = Number.isSafeInteger(counts.inbox) && counts.inbox > 0 ? counts.inbox : 0;
    const suggestions =
      Number.isSafeInteger(counts.suggestions) && counts.suggestions > 0 ? counts.suggestions : 0;
    const pendingTotal = inbox + suggestions;
    if (pendingTotal > 0) {
      return { count: pendingTotal, tone: "warning", label: `${pendingTotal} 项 Agent 建议` };
    }
    const focus = Number.isSafeInteger(counts.focus) && counts.focus > 0 ? counts.focus : 0;
    if (focus > 0) {
      return { count: focus, tone: "neutral", label: `${focus} 项主攻待办` };
    }
    return null;
  } catch {
    return null;
  }
}

function TodoPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<TodoSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [inlineInsert, setInlineInsert] = useState<InlineInsertTarget | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const anchorId = useRef<string | null>(null);
  const dragListeners = useRef<(() => void) | null>(null);
  const initialViewState = useRef<TodoViewState | null>(null);
  if (initialViewState.current === null) initialViewState.current = readViewState();
  const initialView = initialViewState.current;
  const [showDone, setShowDone] = useState(initialView.showDone);
  const [listFilter, setListFilter] = useState<string | null>(initialView.listFilter);
  const [groupByList, setGroupByList] = useState(initialView.groupByList);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(initialView.collapsedSections),
  );

  const refresh = useCallback(() => {
    setActionError(null);
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    rpc.call("listSnapshot", {}).then(
      (next) => {
        if (!active) return;
        setSnapshot(next);
        setLoadFailed(false);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setLoadFailed(true);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, revision]);

  useRealtime(TODO_CHANGED_EVENT, refresh);

  useEffect(() => {
    writeViewState({
      listFilter,
      groupByList,
      collapsedSections: [...collapsedSections],
      showDone,
    });
  }, [collapsedSections, groupByList, listFilter, showDone]);

  useEffect(() => {
    // Only heal after the first snapshot. Before that, lists and done are
    // simply unknown and hydrated filters must be left untouched.
    if (snapshot === null) return;
    setListFilter((current) => {
      if (current === null || current.length === 0) return current;
      const stillExists =
        snapshot.lists.some((list) => list.name === current) ||
        snapshot.done.some((item) => item.listName === current);
      return stillExists ? current : null;
    });
  }, [snapshot]);

  const report = useCallback((message: string) => {
    setActionError(message);
  }, []);

  const selectedSet = new Set(selectedIds);
  const draggingSet = new Set(draggingIds);

  useEffect(() => {
    if (snapshot === null) return;
    const visible = new Set(visibleTodoIds(snapshot, listFilter, groupByList, collapsedSections));
    setSelectedIds((current) => {
      const next = current.filter((id) => visible.has(id));
      return next.length === current.length ? current : next;
    });
    if (anchorId.current !== null && !visible.has(anchorId.current)) anchorId.current = null;
  }, [collapsedSections, groupByList, listFilter, snapshot]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("textarea, input, select")) return;
      if (dragListeners.current) {
        dragListeners.current();
        dragListeners.current = null;
        setDraggingIds([]);
        setDropTarget(null);
      }
      setSelectedIds([]);
      anchorId.current = null;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => () => dragListeners.current?.(), []);

  const orderedSelection = useCallback(
    (ids: Iterable<string>) => {
      if (snapshot === null) return [...ids];
      const wanted = new Set(ids);
      return visibleTodoIds(snapshot, listFilter, groupByList, collapsedSections).filter((id) => wanted.has(id));
    },
    [collapsedSections, groupByList, listFilter, snapshot],
  );

  const onRangeSelect = (id: string, event: ReactMouseEvent) => {
    if (snapshot === null) return;
    const order = visibleTodoIds(snapshot, listFilter, groupByList, collapsedSections);
    if (event.shiftKey && anchorId.current) {
      const start = order.indexOf(anchorId.current);
      const end = order.indexOf(id);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        setSelectedIds(order.slice(from, to + 1));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedIds(order.filter((itemId) => next.has(itemId)));
      anchorId.current = id;
      return;
    }
    setSelectedIds([id]);
    anchorId.current = id;
  };

  const runBatch = async (action: "complete" | "delete" | "move", bucket?: TodoFormalBucket) => {
    const ids = orderedSelection(selectedIds);
    if (ids.length === 0) return;
    try {
      await rpc.call("batch", { ids, action, ...(bucket ? { bucket } : {}) });
      setSelectedIds([]);
      anchorId.current = null;
      refresh();
    } catch {
      report(
        action === "delete" ? "没能删除所选待办。" : action === "complete" ? "没能完成所选待办。" : "没能移动所选待办。",
      );
    }
  };

  const onDragStart = (item: TodoItem, event: ReactPointerEvent<HTMLButtonElement>) => {
    dragListeners.current?.();
    const ids =
      selectedSet.has(item.id) && snapshot !== null
        ? orderedSelection(selectedIds)
        : [item.id];
    const draggedBuckets = new Set(
      ids.map((id) => {
        for (const bucket of FORMAL_BUCKETS) {
          if (snapshot?.buckets[bucket].some((row) => row.id === id)) return bucket;
        }
        return item.bucket;
      }),
    );
    const originX = event.clientX;
    const originY = event.clientY;
    let armed = false;
    let latest: DropTarget | null = null;
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = "";
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== event.pointerId) return;
      if (!armed) {
        if (Math.hypot(pointer.clientX - originX, pointer.clientY - originY) < 4) return;
        armed = true;
        document.body.style.userSelect = "none";
        setDraggingIds(ids);
      }
      const next = readDropTarget(pointer.clientX, pointer.clientY, listFilter !== null || groupByList);
      latest = next;
      setDropTarget((current) =>
        current?.bucket === next?.bucket &&
        current?.listName === next?.listName &&
        current?.sectionName === next?.sectionName &&
        current?.beforeId === next?.beforeId
          ? current
          : next,
      );
    };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== event.pointerId) return;
      stop();
      dragListeners.current = null;
      setDraggingIds([]);
      setDropTarget(null);
      if (!armed || latest === null) return;
      const grouped = listFilter !== null || groupByList;
      if (!grouped && (draggedBuckets.size !== 1 || !draggedBuckets.has(latest.bucket))) return;
      const beforeId = resolveBeforeId(latest, ids, grouped);
      if (latest.beforeId !== null && ids.includes(latest.beforeId) && beforeId === null) return;
      void rpc
        .call("reorder", {
          ids,
          ...(beforeId ? { beforeId } : {}),
          bucket: latest.bucket,
          ...(grouped ? { listName: latest.listName, sectionName: latest.sectionName } : {}),
        })
        .then(
          (result) => {
            if (result.changed) refresh();
          },
          () => report("没能调整顺序。"),
        );
    };
    dragListeners.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const formalItems = snapshot
    ? [...snapshot.buckets.focus, ...snapshot.buckets.later, ...snapshot.buckets.waiting]
    : [];
  const visibleFormal = formalItems.filter((item) => listFilter === null || item.listName === listFilter);
  const uncategorized = formalItems.filter((item) => item.listName.length === 0).length;
  const doneItems = snapshot
    ? snapshot.done.filter((item) => listFilter === null || item.listName === listFilter)
    : [];
  const doneCount = snapshot ? (listFilter === null ? snapshot.counts.done : doneItems.length) : 0;
  const nothingOpen =
    snapshot !== null &&
    snapshot.counts.open === 0 &&
    snapshot.counts.inbox === 0 &&
    snapshot.counts.suggestions === 0 &&
    snapshot.counts.done === 0;
  const selectedList = listFilter && listFilter.length > 0 ? listFilter : null;
  const selectedColor = snapshot && selectedList ? colorOf(snapshot.lists, selectedList) : null;

  const recolor = async (listName: string, color: TodoColor) => {
    try {
      await rpc.call("setListColor", { listName, color });
      refresh();
    } catch {
      report(`没能更换 ${listName} 的颜色。`);
    }
  };

  return (
    <div className="h-full touch-manipulation overflow-y-auto bg-background text-foreground [--text-base:16px]">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-2.5 py-3 sm:space-y-6 sm:px-5 sm:py-5">
        <QuickAdd inheritList={selectedList} onAdded={refresh} onError={report} />
        {actionError ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2 text-xs text-destructive"
          >
            <span>{actionError}</span>
            <button type="button" className={quietButtonClassName} onClick={() => setActionError(null)}>
              关闭
            </button>
          </div>
        ) : null}
        {loadFailed && snapshot !== null ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground"
          >
            <span>刷新失败，正在显示上一次的内容。</span>
            <button type="button" className={quietButtonClassName} onClick={refresh}>
              重试
            </button>
          </div>
        ) : null}
        {snapshot === null ? (
          loading ? (
            <p role="status" className="py-10 text-center text-sm text-muted-foreground">
              加载中…
            </p>
          ) : (
            <div role="alert" className="rounded-2xl border border-border bg-card p-6 text-center">
              <p className="text-sm text-muted-foreground">没能加载待办。</p>
              <button type="button" className={`${quietButtonClassName} mt-2`} onClick={refresh}>
                重试
              </button>
            </div>
          )
        ) : (
          <>
            {snapshot.counts.open > 0 ? (
              <ListBar
                lists={snapshot.lists}
                uncategorized={uncategorized}
                total={snapshot.counts.open}
                selected={listFilter}
                groupByList={groupByList}
                onSelect={setListFilter}
                onToggleGroup={() => setGroupByList((value) => !value)}
                onRecolor={(listName, color) => void recolor(listName, color)}
              />
            ) : null}
            {selectedList ? (
              <ListHeading name={selectedList} color={selectedColor} />
            ) : null}
            <AgentSuggestionsSection
              suggestions={snapshot.suggestions}
              inbox={snapshot.buckets.inbox}
              listFilter={listFilter}
              targets={formalItems}
              onChanged={refresh}
              onError={report}
            />
            {selectedIds.length > 0 ? (
              <div
                role="toolbar"
                aria-label="批量操作"
                className="sticky top-0 z-10 flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card px-2.5 py-2"
              >
                <span className="mr-1 text-xs font-medium text-foreground">已选 {selectedIds.length}</span>
                <button type="button" className={primaryButtonClassName} onClick={() => void runBatch("complete")}>
                  完成所选
                </button>
                {FORMAL_BUCKETS.map((bucket) => (
                  <button
                    key={bucket}
                    type="button"
                    className={quietButtonClassName}
                    onClick={() => void runBatch("move", bucket)}
                  >
                    移到 {BUCKET_LABEL[bucket]}
                  </button>
                ))}
                <button type="button" className={quietButtonClassName} onClick={() => void runBatch("delete")}>
                  删除所选
                </button>
                <button
                  type="button"
                  className={quietButtonClassName}
                  onClick={() => {
                    setSelectedIds([]);
                    anchorId.current = null;
                  }}
                >
                  取消选择
                </button>
              </div>
            ) : null}
            {nothingOpen ? (
              <EmptyState />
            ) : (
              <div className="space-y-4 sm:space-y-6">
                {visibleFormal.length === 0 && listFilter !== null ? (
                  <p className="px-2 text-xs text-muted-foreground">这个列表里还没有未完成待办。</p>
                ) : null}
                {FORMAL_BUCKETS.map((bucket) => (
                  <TodoSection
                    key={bucket}
                    bucket={bucket}
                    items={snapshot.buckets[bucket]}
                    lists={snapshot.lists}
                    listFilter={listFilter}
                    groupByList={groupByList}
                    collapsedSections={collapsedSections}
                    suggestedItemIds={new Set(snapshot.suggestions.map((suggestion) => suggestion.itemId))}
                    expandedId={expandedId}
                    inlineInsert={inlineInsert}
                    selectedIds={selectedSet}
                    draggingIds={draggingSet}
                    dropTarget={dropTarget}
                    onRangeSelect={onRangeSelect}
                    onDragStart={onDragStart}
                    onToggleSection={(key) => {
                      setCollapsedSections((current) => {
                        const next = new Set(current);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      });
                    }}
                    onToggle={(id) => {
                      setExpandedId((current) => (current === id ? null : id));
                    }}
                    onShowThreads={(id) => setExpandedId(id)}
                    onStartInlineAfter={(item) => {
                      if (item.bucket === "inbox") return;
                      setInlineInsert({
                        kind: "after",
                        afterId: item.id,
                        bucket: item.bucket,
                        listName: item.listName,
                        sectionName: item.sectionName,
                      });
                    }}
                    onStartInlineBottom={(key, targetBucket, listName, sectionName, afterId) => {
                      setInlineInsert({
                        kind: "bottom",
                        key,
                        afterId,
                        bucket: targetBucket,
                        listName,
                        sectionName,
                      });
                    }}
                    onInlineSubmitted={(created) => {
                      setInlineInsert((current) => {
                        if (!current) return null;
                        return { ...current, afterId: created.id };
                      });
                      refresh();
                    }}
                    onInlineCancel={() => setInlineInsert(null)}
                    onChanged={refresh}
                    onError={report}
                  />
                ))}
              </div>
            )}
            {doneCount > 0 ? (
              <CompletedSection
                items={doneItems}
                count={doneCount}
                lists={snapshot.lists}
                expanded={showDone}
                onToggleExpanded={() => setShowDone((value) => !value)}
                onChanged={refresh}
                onError={report}
              />
            ) : null}
            <HistorySection refreshToken={revision} onChanged={refresh} onError={report} />
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "todo",
    title: "Todo",
    icon: "ListChecks",
    path: "todo",
    component: TodoPanel,
    experimental_useBadge: useTodoBadge,
  });
});
