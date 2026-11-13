import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
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
  TODO_FORMAL_BUCKETS,
  type TodoCounts,
  type TodoFormalBucket,
  type TodoItem,
  type TodoLogEntry,
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

const fieldClassName =
  "w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const quietButtonClassName =
  "cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const primaryButtonClassName =
  "cursor-pointer rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

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

/** Quiet chips that jump into the BB threads an agent linked. */
function ThreadCapsules({ threads }: { threads: TodoThreadLink[] }) {
  const navigate = useBbNavigate();
  if (threads.length === 0) return null;
  return (
    <div className="flex max-w-[55%] min-w-0 flex-wrap items-center justify-end gap-1">
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
          className="inline-flex max-w-40 min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              isRunningStatus(link.threadStatus)
                ? "animate-pulse bg-primary"
                : "bg-muted-foreground"
            }`}
          />
          <span className="truncate">{threadLabel(link)}</span>
        </button>
      ))}
    </div>
  );
}

function BucketPills({
  value,
  onChange,
  label = "添加到分组",
}: {
  value: TodoFormalBucket;
  onChange(bucket: TodoFormalBucket): void;
  label?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-muted p-0.5"
    >
      {FORMAL_BUCKETS.map((bucket) => {
        const active = bucket === value;
        return (
          <button
            key={bucket}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(bucket)}
            className={`cursor-pointer rounded-full px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {BUCKET_LABEL[bucket]}
          </button>
        );
      })}
    </div>
  );
}

/** The one-line add bar: type a title, press Enter, done. */
function QuickAdd({
  onAdded,
  onError,
}: {
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
    try {
      await rpc.call("quickAdd", { title: trimmed, bucket });
      setTitle("");
      onAdded();
    } catch {
      onError("没能添加这条待办，请再试一次。");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-2 shadow-sm transition-shadow focus-within:border-primary/40 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="添加待办"
          title="添加待办"
          disabled={adding || title.trim().length === 0}
          onClick={() => void submit()}
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
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
            // Enter that confirms an IME candidate must never create a todo.
            if (composing.current || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
          className="min-w-0 flex-1 bg-transparent py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <BucketPills value={bucket} onChange={setBucket} />
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

  const accept = () =>
    void run("accept", { id: item.id, action: "accept", bucket: acceptBucket });

  const confirmMerge = () => {
    if (mergeInto.length === 0) return;
    void run("merge", { id: item.id, action: "merge", intoId: mergeInto });
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
      <div className="mt-2">
        <ThreadCapsules threads={item.threads} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-full border border-border bg-card p-0.5">
          <select
            aria-label={`采纳 ${item.id} 到分组`}
            value={acceptBucket}
            onChange={(event) => setAcceptBucket(event.target.value as TodoFormalBucket)}
            className="cursor-pointer rounded-full bg-transparent px-1.5 py-0.5 text-[11px] text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            onClick={accept}
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
            className="min-w-0 flex-1 cursor-pointer rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            onClick={confirmMerge}
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
          <InboxRow
            key={item.id}
            item={item}
            targets={targets}
            onChanged={onChanged}
            onError={onError}
          />
        ))}
      </ul>
    </section>
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
            className="cursor-pointer rounded text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {shortThreadId(threadId)}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** Quiet inline editor that opens under the row instead of a modal. */
function TodoDetails({
  item,
  onChanged,
  onError,
  onCollapse,
}: {
  item: TodoItem;
  onChanged(): void;
  onError(message: string): void;
  onCollapse(): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [title, setTitle] = useState(item.title);
  const [bucket, setBucket] = useState<TodoFormalBucket>(item.bucket as TodoFormalBucket);
  const [nextStep, setNextStep] = useState(item.nextStep);
  const [notes, setNotes] = useState(item.notes);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [saved, setSaved] = useState(false);
  const baseline = useRef({
    title: item.title,
    bucket: item.bucket as TodoFormalBucket,
    nextStep: item.nextStep,
    notes: item.notes,
  });

  useEffect(() => {
    const next = {
      title: item.title,
      bucket: item.bucket as TodoFormalBucket,
      nextStep: item.nextStep,
      notes: item.notes,
    };
    baseline.current = next;
    setTitle(next.title);
    setBucket(next.bucket);
    setNextStep(next.nextStep);
    setNotes(next.notes);
    setSaved(false);
  }, [item.id, item.title, item.bucket, item.nextStep, item.notes, item.updatedAt]);

  const dirty =
    title.trim() !== baseline.current.title ||
    bucket !== baseline.current.bucket ||
    nextStep !== baseline.current.nextStep ||
    notes !== baseline.current.notes;

  const save = async () => {
    if (saving) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      onError("标题不能为空。");
      return;
    }
    const patch: { title?: string; bucket?: TodoFormalBucket; nextStep?: string; notes?: string } = {};
    if (trimmedTitle !== baseline.current.title) patch.title = trimmedTitle;
    if (bucket !== baseline.current.bucket) patch.bucket = bucket;
    if (nextStep !== baseline.current.nextStep) patch.nextStep = nextStep;
    if (notes !== baseline.current.notes) patch.notes = notes;
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      await rpc.call("update", { id: item.id, ...patch });
      baseline.current = {
        title: trimmedTitle,
        bucket,
        nextStep,
        notes,
      };
      setTitle(trimmedTitle);
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
          <span className="text-[11px] text-muted-foreground">下一步</span>
          <input
            aria-label={`下一步 ${item.id}`}
            value={nextStep}
            maxLength={2000}
            placeholder="下一步做什么？"
            onChange={(event) => setNextStep(event.target.value)}
            className={fieldClassName}
          />
        </label>
        <label className="space-y-1 md:col-span-2">
          <span className="text-[11px] text-muted-foreground">备注</span>
          <textarea
            aria-label={`备注 ${item.id}`}
            value={notes}
            rows={3}
            maxLength={20000}
            placeholder="补充背景、链接或判断"
            onChange={(event) => setNotes(event.target.value)}
            className={`${fieldClassName} resize-y`}
          />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={saving || !dirty}
          onClick={() => void save()}
          className={primaryButtonClassName}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <span className="text-[11px] text-muted-foreground">
          {saved && !dirty ? "已保存" : "⌘/Ctrl + Enter 保存"}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          disabled={saving || removing}
          onClick={() => void remove()}
          aria-label={`删除 ${item.id}`}
          className="cursor-pointer rounded-md px-2 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
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
  expanded,
  divider,
  onToggle,
  onChanged,
  onError,
}: {
  item: TodoItem;
  expanded: boolean;
  divider: boolean;
  onToggle(): void;
  onChanged(): void;
  onError(message: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [pendingCompleted, setPendingCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const detailsId = `todo-details-${item.id}`;
  const completed = item.completedAt !== null;
  const checked = completed || pendingCompleted;

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
    <li className={divider ? "border-t border-border" : undefined}>
      <div
        onClick={onSurfaceClick}
        className={`group flex items-start gap-3 px-3 py-2.5 transition-colors ${
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
          className={`mt-0.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground bg-transparent text-transparent hover:border-primary"
          }`}
        >
          <CheckIcon />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="break-words text-sm leading-5 text-foreground">{item.title}</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{item.id}</span>
          </div>
          {item.nextStep ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              下一步：{item.nextStep}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ThreadCapsules threads={item.threads} />
          <button
            type="button"
            aria-label={expanded ? `收起 ${item.id} 详情` : `展开 ${item.id} 详情`}
            aria-expanded={expanded}
            aria-controls={expanded ? detailsId : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronIcon open={expanded} />
          </button>
        </div>
      </div>
      {expanded ? (
        <div id={detailsId} className="border-t border-border bg-card px-3 py-3">
          <TodoDetails
            item={item}
            onChanged={onChanged}
            onError={onError}
            onCollapse={onToggle}
          />
        </div>
      ) : null}
    </li>
  );
}

function TodoSection({
  bucket,
  items,
  expandedId,
  onToggle,
  onChanged,
  onError,
}: {
  bucket: TodoFormalBucket;
  items: TodoItem[];
  expandedId: string | null;
  onToggle(id: string): void;
  onChanged(): void;
  onError(message: string): void;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={`${BUCKET_LABEL[bucket]} 待办`} className="space-y-2">
      <div className="flex items-baseline gap-2 px-2">
        <h2 className="text-[13px] font-semibold text-foreground">{BUCKET_LABEL[bucket]}</h2>
        <span className="text-[11px] tabular-nums text-muted-foreground">{items.length}</span>
      </div>
      <ul className="overflow-hidden rounded-2xl border border-border bg-card">
        {items.map((item, index) => (
          <TodoRow
            key={item.id}
            item={item}
            divider={index > 0}
            expanded={expandedId === item.id}
            onToggle={() => onToggle(item.id)}
            onChanged={onChanged}
            onError={onError}
          />
        ))}
      </ul>
    </section>
  );
}

function DoneRow({
  item,
  divider,
  onChanged,
  onError,
}: {
  item: TodoItem;
  divider: boolean;
  onChanged(): void;
  onError(message: string): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [pendingRestore, setPendingRestore] = useState(false);
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
    <li className={`flex items-center gap-3 px-3 py-2 ${divider ? "border-t border-border" : ""}`}>
      <button
        type="button"
        role="checkbox"
        aria-checked="true"
        aria-label={`恢复 ${item.id}`}
        disabled={busy}
        onClick={() => void restore()}
        className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-primary bg-primary text-primary-foreground transition-all duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <CheckIcon />
      </button>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{item.title}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{item.id}</span>
      {item.completedAt ? (
        <time className="text-[11px] text-muted-foreground" dateTime={item.completedAt}>
          {formatTime(item.completedAt)}
        </time>
      ) : null}
    </li>
  );
}

function CompletedSection({
  items,
  count,
  expanded,
  onToggleExpanded,
  onChanged,
  onError,
}: {
  items: TodoItem[];
  count: number;
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
        className="flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-2">
          <ChevronIcon open={expanded} />
          已完成
        </span>
        <span className="tabular-nums">{count}</span>
      </button>
      {expanded ? (
        <ul className="animate-in fade-in slide-in-from-top-1 mt-1 overflow-hidden rounded-2xl border border-border bg-card duration-150">
          {items.length === 0 ? (
            <li className="px-3 py-3 text-xs text-muted-foreground">还没有完成项。</li>
          ) : (
            items.map((item, index) => (
              <DoneRow
                key={item.id}
                item={item}
                divider={index > 0}
                onChanged={onChanged}
                onError={onError}
              />
            ))
          )}
          {count > items.length ? (
            <li className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              仅显示最近 {items.length} 项
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
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

/**
 * Navigation badge: inbox proposals win, then focus items. Any failure is
 * reported as "no badge" so a transient RPC error never becomes a crashed
 * navigation slot.
 */
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
    ? [
        ...snapshot.buckets.focus,
        ...snapshot.buckets.later,
        ...snapshot.buckets.waiting,
      ]
    : [];
  const nothingOpen =
    snapshot !== null &&
    snapshot.counts.open === 0 &&
    snapshot.counts.inbox === 0 &&
    snapshot.counts.done === 0;

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6">
        <QuickAdd onAdded={refresh} onError={report} />
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
            <InboxSection
              items={snapshot.buckets.inbox}
              targets={formalItems}
              onChanged={refresh}
              onError={report}
            />
            {nothingOpen ? (
              <EmptyState />
            ) : (
              <div className="space-y-6">
                {FORMAL_BUCKETS.map((bucket) => (
                  <TodoSection
                    key={bucket}
                    bucket={bucket}
                    items={snapshot.buckets[bucket]}
                    expandedId={expandedId}
                    onToggle={(id) => {
                      setExpandedId((current) => (current === id ? null : id));
                    }}
                    onChanged={refresh}
                    onError={report}
                  />
                ))}
              </div>
            )}
            {snapshot.counts.done > 0 ? (
              <CompletedSection
                items={snapshot.done}
                count={snapshot.counts.done}
                expanded={showDone}
                onToggleExpanded={() => setShowDone((value) => !value)}
                onChanged={refresh}
                onError={report}
              />
            ) : null}
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
