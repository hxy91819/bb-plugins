import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
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

  return (
    <li className="rounded-xl border border-border bg-background p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-foreground">{item.title}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{item.id}</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        <span className="text-muted-foreground">来源：</span>
        {item.proposalReason || "Agent 从最近的记录中提议"}
      </p>
      {item.listName ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          建议归入 {item.listName}
          {item.sectionName ? ` / ${item.sectionName}` : ""}
        </p>
      ) : null}
      <div className="mt-2">
        <ThreadCapsules threads={item.threads} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-full border border-border bg-card p-0.5">
          <select
            aria-label={`采纳 ${item.id} 到分组`}
            value={acceptBucket}
            onChange={(event) => setAcceptBucket(event.target.value as TodoFormalBucket)}
            className="touch-manipulation cursor-pointer rounded-full bg-transparent px-1.5 py-0.5 text-base text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
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
            onClick={() => void run("accept", { id: item.id, action: "accept", bucket: acceptBucket })}
            className={primaryButtonClassName}
          >
            采纳
          </button>
        </div>
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
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void run("dismiss", { id: item.id, action: "dismiss" })}
          className={quietButtonClassName}
        >
          忽略
        </button>
      </div>
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

function InboxSection({
  items,
  targets,
  onChanged,
  onError,
}: {
  items: TodoItem[];
  targets: TodoItem[];
  onChanged(): void;
  onError(message: string): void;
}) {
  if (items.length === 0) return null;
  return (
    <section
      aria-label="待确认提议"
      className="space-y-2 rounded-2xl border border-border bg-card p-3 shadow-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <h2 className="text-xs font-medium text-foreground">
          待确认 <span className="tabular-nums text-muted-foreground">{items.length}</span>
        </h2>
        <p className="text-[11px] text-muted-foreground">Agent 从纪要与会话里提议的新事项</p>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
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
  onChanged,
  onError,
  onCollapse,
}: {
  item: TodoItem;
  listNames: string[];
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
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium tabular-nums text-foreground">
          {item.id}
        </span>
        <span>详情</span>
      </div>
      {item.threads.length > 0 ? (
        <div className="mb-3 space-y-1">
          <h3 className="text-[11px] font-medium text-muted-foreground">关联会话</h3>
          <ThreadCapsules threads={item.threads} />
        </div>
      ) : null}
      <div className="grid gap-2 md:grid-cols-2">
        <label className="space-y-1 md:col-span-2">
          <span className="text-[11px] text-muted-foreground">标题</span>
          <input
            aria-label={`标题 ${item.id}`}
            value={title}
            maxLength={500}
            onChange={(event) => setTitle(event.target.value)}
            className={fieldClassName}
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">分组</span>
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
          <span className="text-[11px] text-muted-foreground">项目列表</span>
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
          <span className="text-[11px] text-muted-foreground">子分组（Section）</span>
          <input
            aria-label={`分组（Section） ${item.id}`}
            value={sectionName}
            maxLength={80}
            placeholder="列表内的子分组"
            onChange={(event) => setSectionName(event.target.value)}
            className={fieldClassName}
          />
        </label>
        <label className="space-y-1 md:col-span-2">
          <span className="text-[11px] text-muted-foreground">备注</span>
          <textarea
            aria-label={`备注 ${item.id}`}
            value={notes}
            rows={4}
            maxLength={20000}
            placeholder="补充背景、验收要点或链接"
            onChange={(event) => setNotes(event.target.value)}
            className={`${fieldClassName} resize-y`}
          />
        </label>
      </div>
      <datalist id="todo-list-names">
        {listNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" disabled={saving || !dirty} onClick={() => void save()} className={primaryButtonClassName}>
          {saving ? "保存中…" : "保存"}
        </button>
        <span className="text-[11px] text-muted-foreground">{saved && !dirty ? "已保存" : "⌘/Ctrl + Enter 保存"}</span>
        <StartSessionButton item={item} onError={onError} variant="label" />
        <span className="flex-1" />
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
      <div className="mt-3 space-y-2">
        <h3 className="text-[11px] font-medium text-muted-foreground">进展日志</h3>
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
    </div>
  );
}

function TodoRow({
  item,
  lists,
  showListChip,
  expanded,
  divider,
  onToggle,
  onShowThreads,
  onChanged,
  onError,
}: {
  item: TodoItem;
  lists: TodoListSummary[];
  showListChip: boolean;
  expanded: boolean;
  divider: boolean;
  onToggle(): void;
  onShowThreads(): void;
  onChanged(): void;
  onError(message: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [pendingCompleted, setPendingCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const detailsId = `todo-details-${item.id}`;
  const completed = item.completedAt !== null;
  const checked = completed || pendingCompleted;
  const color = colorOf(lists, item.listName);
  const listNames = lists.map((list) => list.name);

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

  const onSurfaceClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea, label")) return;
    onToggle();
  };

  return (
    <div
      className={divider ? "border-t border-border" : undefined}
      data-todo-row
      title={`${item.id} ${item.title}`}
    >
      <div
        onClick={onSurfaceClick}
        className={`group flex items-start gap-2.5 px-2.5 py-2.5 transition-colors sm:px-3.5 ${
          expanded ? "bg-muted" : "hover:bg-accent"
        }`}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={`完成 ${item.id}`}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            void toggleCompleted();
          }}
          style={checkStyle(color, checked)}
          className={`mt-0.5 flex h-5 w-5 shrink-0 touch-manipulation cursor-pointer appearance-none items-center justify-center rounded-full border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${
            color
              ? ""
              : checked
                ? "border-primary bg-primary text-primary-foreground"
                : "border-muted-foreground bg-transparent text-transparent hover:border-primary"
          }`}
        >
          <CheckIcon />
        </button>
        <div className="min-w-0 flex-1" data-todo-main>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            <p
              data-todo-title
              title={`${item.id} ${item.title}`}
              className="min-w-0 break-words text-sm font-medium leading-5 text-foreground"
            >
              {item.title}
            </p>
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
        </div>
        <div className="flex shrink-0 items-center gap-0.5" data-todo-rail>
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
        <div id={detailsId} className="border-t border-border bg-card px-2.5 py-3 sm:px-3.5">
          <TodoDetails
            item={item}
            listNames={listNames}
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
  onToggle,
}: {
  sectionName: string;
  count: number;
  color: TodoColor | null;
  collapsed: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="flex w-full touch-manipulation cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

function TodoSection({
  bucket,
  items,
  lists,
  listFilter,
  groupByList,
  collapsedSections,
  expandedId,
  onToggleSection,
  onToggle,
  onShowThreads,
  onChanged,
  onError,
}: {
  bucket: TodoFormalBucket;
  items: TodoItem[];
  lists: TodoListSummary[];
  listFilter: string | null;
  groupByList: boolean;
  collapsedSections: ReadonlySet<string>;
  expandedId: string | null;
  onToggleSection(key: string): void;
  onToggle(id: string): void;
  onShowThreads(id: string): void;
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

  const renderRows = (rows: TodoItem[], offset: number) =>
    rows.map((item, index) => (
      <TodoRow
        key={item.id}
        item={item}
        lists={lists}
        showListChip={showChip}
        divider={offset + index > 0}
        expanded={expandedId === item.id}
        onToggle={() => onToggle(item.id)}
        onShowThreads={() => onShowThreads(item.id)}
        onChanged={onChanged}
        onError={onError}
      />
    ));

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
                    onToggle={() => onToggleSection(key)}
                  />
                  {collapsed ? null : renderRows(rows, start)}
                </div>
              );
            })}
          </div>
        );
      })
    : renderRows(visible, 0);

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
        style={checkStyle(color, true)}
        className={`mt-0.5 flex h-5 w-5 shrink-0 touch-manipulation cursor-pointer items-center justify-center rounded-full border text-primary-foreground transition-all duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${
          color ? "" : "border-primary bg-primary"
        }`}
      >
        <CheckIcon />
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
    if (inbox > 0) {
      return { count: inbox, tone: "warning", label: `${inbox} 项待确认提议` };
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
  const [showDone, setShowDone] = useState(false);
  const [listFilter, setListFilter] = useState<string | null>(null);
  const [groupByList, setGroupByList] = useState(true);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());

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

  const report = useCallback((message: string) => {
    setActionError(message);
  }, []);

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
            <InboxSection
              items={snapshot.buckets.inbox}
              targets={formalItems}
              onChanged={refresh}
              onError={report}
            />
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
                    expandedId={expandedId}
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
