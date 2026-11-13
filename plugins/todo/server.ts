import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  TODO_CHANGED_EVENT,
  TODO_COLORS,
  TODO_DONE_SNAPSHOT_LIMIT,
  TODO_LOG_TEXT_MAX_LENGTH,
  TODO_NEXT_STEP_MAX_LENGTH,
  TODO_NOTES_MAX_LENGTH,
  TODO_PROPOSAL_REASON_MAX_LENGTH,
  TODO_REVISION_LIMIT_DEFAULT,
  TODO_START_RELATED_LIMIT,
  TODO_THREAD_NOTE_MAX_LENGTH,
  TODO_TITLE_MAX_LENGTH,
  addTodoLogInput,
  fallbackTodoColor,
  formatTodoId,
  linkTodoThreadInput,
  parseTodoId,
  prepareStartSessionOutput,
  quickAddInput,
  resolveTodoPlacement,
  rpcContract,
  setTodoCompletedInput,
  todoColorSchema,
  todoCountsSchema,
  todoListSummarySchema,
  todoRevisionSchema,
  todoScanResultSchema,
  todoSnapshotSchema,
  triageInboxInput,
  unlinkTodoThreadInput,
  updateTodoInput,
  type TodoBucket,
  type TodoColor,
  type TodoCounts,
  type TodoFormalBucket,
  type TodoItem,
  type TodoListStatus,
  type TodoListSummary,
  type TodoLogEntry,
  type TodoRevision,
  type TodoRevisionAction,
  type TodoScanResult,
  type TodoSnapshot,
  type TodoThreadLink,
  type TriageAction,
} from "./contract";

/** A user-facing failure that becomes a coded CLI error and a readable RPC error. */
class TodoError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(message: string, code: string, hint?: string) {
    super(message);
    this.name = "TodoError";
    this.code = code;
    this.hint = hint;
  }
}

type ItemRow = {
  seq: number;
  title: string;
  bucket: TodoBucket;
  notes: string;
  next_step: string;
  proposal_reason: string | null;
  list_name: string;
  section_name: string;
  completed_at: string | null;
  deleted_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type ItemSnapshot = {
  item: ItemRow;
  threads: ThreadRow[];
  logs: LogRow[];
};

type ThreadRow = {
  item_seq: number;
  thread_id: string;
  note: string;
  linked_at: string;
};

type LogRow = {
  id: number;
  item_seq: number;
  text: string;
  thread_id: string | null;
  created_at: string;
};

const escapeLikePattern = (value: string) => value.replace(/[\\%_]/g, "\\$&");

function parseCli<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path.map(String).filter((part) => part.length > 0) ?? [];
  throw new PluginCliError(issue?.message ?? "Invalid input", {
    code: "invalid_input",
    hint:
      path.length > 0
        ? `Check ${path.map((part) => `--${part}`).join(", ")}.`
        : "Run `bb todo --help` for command syntax.",
  });
}

function cliTodoId(raw: string): string {
  const seq = parseTodoId(raw);
  if (seq === null) {
    throw new PluginCliError(`Invalid todo id: ${raw}`, {
      code: "invalid_id",
      hint: "Use a todo id like T-1, t-1, or 1.",
    });
  }
  return formatTodoId(seq);
}

const jsonOption = {
  type: "boolean",
  description: "Emit machine-readable JSON.",
} as const;

const proposeTodoInput = z.object({
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH),
  reason: z.string().trim().min(1).max(TODO_PROPOSAL_REASON_MAX_LENGTH),
  notes: z.string().max(TODO_NOTES_MAX_LENGTH).default(""),
  nextStep: z.string().max(TODO_NEXT_STEP_MAX_LENGTH).default(""),
  threadId: z.string().trim().min(1).optional(),
});

const quickAddCliInput = quickAddInput.extend({
  notes: z.string().max(TODO_NOTES_MAX_LENGTH).default(""),
  nextStep: z.string().max(TODO_NEXT_STEP_MAX_LENGTH).default(""),
  threadId: z.string().trim().min(1).optional(),
});

type CreateTodoInput = {
  title: string;
  bucket: TodoBucket;
  notes: string;
  nextStep: string;
  proposalReason?: string | null;
  threadId?: string;
  listName?: string;
  sectionName?: string;
};

type UpdateTodoValues = {
  title?: string;
  bucket?: TodoFormalBucket;
  notes?: string;
  nextStep?: string;
  listName?: string;
  sectionName?: string;
  sortOrder?: number;
};

function revisionActor(ctx?: { threadId?: string }): string {
  const threadId = ctx?.threadId?.trim() || process.env.BB_THREAD_ID?.trim() || "";
  return threadId.length > 0 ? `agent:${threadId}` : "cli";
}

function clipQuote(title: string): string {
  const text = title.length > 60 ? `${title.slice(0, 60)}…` : title;
  return `「${text}」`;
}

const START_PROMPT_LIMIT = 3_000;
const START_NOTES_LIMIT = 800;
const START_OUTPUT_LIMIT = 400;

type PromptThread = {
  threadId: string;
  outputTail: string | null;
};

function isRunningThread(status: string | null | undefined): boolean {
  return status === "active" || status === "starting";
}

function clipTail(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  if (max <= 1) return "…";
  return `…${trimmed.slice(-(max - 1))}`;
}

function summarizeThreadOutput(output: string | null): string | null {
  if (output === null) return null;
  const compact = output.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return null;
  return clipTail(compact, START_OUTPUT_LIMIT);
}

/** Active threads first, then most recently linked. Capped so the prompt stays short. */
function selectPromptThreads(threads: TodoThreadLink[]): TodoThreadLink[] {
  return [...threads]
    .sort((left, right) => {
      const activity =
        Number(isRunningThread(right.threadStatus)) - Number(isRunningThread(left.threadStatus));
      if (activity !== 0) return activity;
      const recent = right.linkedAt.localeCompare(left.linkedAt);
      if (recent !== 0) return recent;
      return left.threadId.localeCompare(right.threadId);
    })
    .slice(0, TODO_START_RELATED_LIMIT);
}

/** Newest linked thread whose lookup returned a project, ignoring activity. */
function recommendStartEnvironment(threads: TodoThreadLink[]): {
  projectId: string | null;
  environmentId: string | null;
} {
  const chosen = [...threads]
    .filter((thread) => Boolean(thread.projectId))
    .sort((left, right) => {
      const recent = right.linkedAt.localeCompare(left.linkedAt);
      if (recent !== 0) return recent;
      return left.threadId.localeCompare(right.threadId);
    })[0];
  return {
    projectId: chosen?.projectId ?? null,
    environmentId: chosen?.environmentId ?? null,
  };
}

function buildStartInstruction(itemId: string, hasThreads: boolean): string {
  if (!hasThreads) {
    return `开工第一步先运行 \`bb todo link ${itemId}\` 将本会话绑定到该待办，然后按上面的下一步和备注推进；阶段收口时用 \`bb todo log ${itemId}\` 更新进展。`;
  }
  return `开工第一步先运行 \`bb todo link ${itemId}\` 将本会话绑定到该待办；请结合上述 \`@thread:...\` 关联会话的上下文（需要细节时用 \`bb thread log <threadId> --limit 10\` 捞取）继续推进，阶段收口时用 \`bb todo log ${itemId}\` 更新进展。`;
}

function buildStartPrompt(
  item: Pick<TodoItem, "id" | "title" | "nextStep" | "notes">,
  threads: PromptThread[],
  omittedCount: number,
): string {
  const instruction = buildStartInstruction(item.id, threads.length > 0);
  const assemble = (notesLimit: number, outputLimit: number): string => {
    const parts: string[] = [`推进待办 ${item.id}：${item.title}`];
    const nextStep = item.nextStep.trim();
    if (nextStep.length > 0) parts.push(`下一步：${nextStep}`);
    const notes = item.notes.trim();
    if (notes.length > 0 && notesLimit > 0) {
      const truncated = notes.length > notesLimit;
      const body = truncated ? notes.slice(0, notesLimit).trimEnd() : notes;
      parts.push(
        truncated
          ? `备注：\n${body}\n（备注已截断，运行 \`bb todo show ${item.id}\` 查看完整备注。）`
          : `备注：\n${body}`,
      );
    } else if (notes.length > 0) {
      parts.push(`备注已省略，运行 \`bb todo show ${item.id}\` 查看完整备注。`);
    }
    if (threads.length > 0) {
      const lines = ["关联会话：", ...threads.map((thread) => `@thread:${thread.threadId}`)];
      if (omittedCount > 0) {
        lines.push(`其余 ${omittedCount} 个关联会话未列入，需要时运行 \`bb todo show ${item.id}\`。`);
      }
      parts.push(lines.join("\n"));
      const clues = threads.flatMap((thread) => {
        if (!thread.outputTail || outputLimit <= 0) return [];
        const tail = clipTail(thread.outputTail, outputLimit);
        return tail.length > 0 ? [`- @thread:${thread.threadId}：${tail}`] : [];
      });
      if (clues.length > 0) parts.push(["最近上下文：", ...clues].join("\n"));
    }
    return parts.join("\n\n");
  };

  let notesLimit = START_NOTES_LIMIT;
  let outputLimit = START_OUTPUT_LIMIT;
  let body = assemble(notesLimit, outputLimit);
  while (
    `${body}\n\n${instruction}`.length > START_PROMPT_LIMIT &&
    (notesLimit > 0 || outputLimit > 0)
  ) {
    if (outputLimit > 0) outputLimit = Math.max(0, outputLimit - 80);
    else notesLimit = Math.max(0, notesLimit - 80);
    body = assemble(notesLimit, outputLimit);
  }
  const combined = body.length > 0 ? `${body}\n\n${instruction}` : instruction;
  if (combined.length <= START_PROMPT_LIMIT) return combined;
  const budget = START_PROMPT_LIMIT - instruction.length - 2;
  if (budget <= 1) return instruction.slice(0, START_PROMPT_LIMIT);
  return `${body.slice(0, budget - 1).trimEnd()}…\n\n${instruction}`;
}

export default function plugin(bb: BbPluginApi): void {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE todo_items (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      bucket TEXT NOT NULL CHECK (bucket IN ('inbox', 'focus', 'later', 'waiting')),
      notes TEXT NOT NULL DEFAULT '',
      next_step TEXT NOT NULL DEFAULT '',
      proposal_reason TEXT,
      completed_at TEXT,
      sort_order REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX todo_items_open_bucket ON todo_items(completed_at, bucket, sort_order, seq)`,
    `CREATE TABLE todo_threads (
      item_seq INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      linked_at TEXT NOT NULL,
      PRIMARY KEY (item_seq, thread_id)
    )`,
    `CREATE INDEX todo_threads_thread ON todo_threads(thread_id)`,
    `CREATE TABLE todo_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX todo_logs_item ON todo_logs(item_seq, id DESC)`,
    `CREATE TABLE IF NOT EXISTS todo_list_meta (
      list_name TEXT PRIMARY KEY,
      color TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS todo_revisions (
      rev INTEGER PRIMARY KEY AUTOINCREMENT,
      item_seq INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      summary TEXT NOT NULL,
      before_snapshot TEXT,
      after_snapshot TEXT,
      undone_at TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS todo_revisions_item ON todo_revisions(item_seq, rev DESC)`,
  ]);

  const columnNames = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
  const ensureColumn = (table: string, column: string, definition: string) => {
    if (columnNames(table).has(column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  };
  ensureColumn("todo_items", "list_name", "list_name TEXT NOT NULL DEFAULT ''");
  ensureColumn("todo_items", "section_name", "section_name TEXT NOT NULL DEFAULT ''");
  ensureColumn("todo_items", "deleted_at", "deleted_at TEXT");

  const now = () => new Date().toISOString();
  const activeSql = "deleted_at IS NULL";

  const publishChanged = (reason: string, seq: number) => {
    bb.realtime.publish(TODO_CHANGED_EVENT, {
      reason,
      id: formatTodoId(seq),
    });
  };

  const rowToItem = (
    row: ItemRow,
    threads: TodoThreadLink[],
    logs: TodoLogEntry[],
  ): TodoItem => ({
    id: formatTodoId(row.seq),
    seq: row.seq,
    title: row.title,
    bucket: row.bucket,
    notes: row.notes,
    nextStep: row.next_step,
    proposalReason: row.proposal_reason,
    listName: row.list_name,
    sectionName: row.section_name,
    completedAt: row.completed_at,
    deletedAt: row.deleted_at,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    threads,
    logs,
  });

  const queryBySeq = <T>(sqlPrefix: string, sqlSuffix: string, seqs: number[]): T[] => {
    const rows: T[] = [];
    for (let index = 0; index < seqs.length; index += 500) {
      const chunk = seqs.slice(index, index + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      rows.push(
        ...(db
          .prepare(`${sqlPrefix} IN (${placeholders}) ${sqlSuffix}`)
          .all(...chunk) as T[]),
      );
    }
    return rows;
  };

  const hydrate = (rows: ItemRow[]): TodoItem[] => {
    if (rows.length === 0) return [];
    const seqs = rows.map((row) => row.seq);
    const threadRows = queryBySeq<ThreadRow>(
      "SELECT item_seq, thread_id, note, linked_at FROM todo_threads WHERE item_seq",
      "ORDER BY item_seq, linked_at, thread_id",
      seqs,
    );
    const logRows = queryBySeq<LogRow>(
      "SELECT id, item_seq, text, thread_id, created_at FROM todo_logs WHERE item_seq",
      "ORDER BY item_seq, id DESC",
      seqs,
    );
    const threadsByItem = new Map<number, TodoThreadLink[]>();
    for (const row of threadRows) {
      const threads = threadsByItem.get(row.item_seq) ?? [];
      threads.push({
        threadId: row.thread_id,
        note: row.note,
        linkedAt: row.linked_at,
      });
      threadsByItem.set(row.item_seq, threads);
    }
    const logsByItem = new Map<number, TodoLogEntry[]>();
    for (const row of logRows) {
      const logs = logsByItem.get(row.item_seq) ?? [];
      logs.push({
        id: row.id,
        text: row.text,
        threadId: row.thread_id,
        createdAt: row.created_at,
      });
      logsByItem.set(row.item_seq, logs);
    }
    return rows.map((row) =>
      rowToItem(row, threadsByItem.get(row.seq) ?? [], logsByItem.get(row.seq) ?? []),
    );
  };

  const enrichThreads = async (items: TodoItem[]): Promise<TodoItem[]> => {
    const threadIds = [
      ...new Set(items.flatMap((item) => item.threads.map((thread) => thread.threadId))),
    ];
    if (threadIds.length === 0) return items;
    const live = new Map<
      string,
      {
        title: string | null;
        status: string | null;
        projectId: string | null;
        environmentId: string | null;
      }
    >();
    await Promise.all(
      threadIds.map(async (threadId) => {
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          const included = "environment" in thread ? thread.environment : null;
          live.set(threadId, {
            title: thread.title || thread.titleFallback || null,
            status: thread.status ?? null,
            projectId: thread.projectId,
            environmentId: thread.environmentId ?? included?.id ?? null,
          });
        } catch {
          // A deleted or unreachable thread must not hide the todo itself.
          live.set(threadId, {
            title: null,
            status: null,
            projectId: null,
            environmentId: null,
          });
        }
      }),
    );
    return items.map((item) => ({
      ...item,
      threads: item.threads.map((thread) => {
        const current = live.get(thread.threadId);
        return {
          ...thread,
          threadTitle: current?.title ?? null,
          threadStatus: current?.status ?? null,
          projectId: current?.projectId ?? null,
          environmentId: current?.environmentId ?? null,
        };
      }),
    }));
  };

  const readRows = async (rows: ItemRow[]): Promise<TodoItem[]> =>
    enrichThreads(hydrate(rows));

  const itemRow = (seq: number): ItemRow | undefined =>
    db.prepare("SELECT * FROM todo_items WHERE seq = ?").get(seq) as ItemRow | undefined;

  const requireItemRow = (seq: number): ItemRow => {
    const row = itemRow(seq);
    if (!row || row.deleted_at !== null) {
      throw new TodoError(`Todo not found: ${formatTodoId(seq)}`, "not_found", "Run `bb todo list --status all --json` to list ids.");
    }
    return row;
  };

  const captureBundle = (seq: number): ItemSnapshot | null => {
    const item = itemRow(seq);
    if (!item) return null;
    const threads = db
      .prepare(
        "SELECT item_seq, thread_id, note, linked_at FROM todo_threads WHERE item_seq = ? ORDER BY linked_at, thread_id",
      )
      .all(seq) as ThreadRow[];
    const logs = db
      .prepare(
        "SELECT id, item_seq, text, thread_id, created_at FROM todo_logs WHERE item_seq = ? ORDER BY id",
      )
      .all(seq) as LogRow[];
    return { item, threads, logs };
  };

  const encodeSnapshot = (bundles: ItemSnapshot[] | null): string | null =>
    bundles === null ? null : JSON.stringify(bundles);

  const decodeSnapshot = (raw: string | null): ItemSnapshot[] | null => {
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as ItemSnapshot | ItemSnapshot[];
    return Array.isArray(parsed) ? parsed : [parsed];
  };

  const writeRevision = (entry: {
    seq: number;
    action: TodoRevisionAction;
    actor: string;
    summary: string;
    before: ItemSnapshot[] | null;
    after: ItemSnapshot[] | null;
    timestamp: string;
  }) => {
    db.prepare(
      `INSERT INTO todo_revisions
        (item_seq, action, actor, summary, before_snapshot, after_snapshot, undone_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      entry.seq,
      entry.action,
      entry.actor,
      entry.summary,
      encodeSnapshot(entry.before),
      encodeSnapshot(entry.after),
      entry.timestamp,
    );
  };

  const upsertBundle = (bundle: ItemSnapshot) => {
    const item = bundle.item;
    db.prepare(
      `INSERT INTO todo_items (
        seq, title, bucket, notes, next_step, proposal_reason, completed_at, sort_order,
        created_at, updated_at, list_name, section_name, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(seq) DO UPDATE SET
        title = excluded.title,
        bucket = excluded.bucket,
        notes = excluded.notes,
        next_step = excluded.next_step,
        proposal_reason = excluded.proposal_reason,
        completed_at = excluded.completed_at,
        sort_order = excluded.sort_order,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        list_name = excluded.list_name,
        section_name = excluded.section_name,
        deleted_at = excluded.deleted_at`,
    ).run(
      item.seq,
      item.title,
      item.bucket,
      item.notes,
      item.next_step,
      item.proposal_reason,
      item.completed_at,
      item.sort_order,
      item.created_at,
      item.updated_at,
      item.list_name,
      item.section_name,
      item.deleted_at,
    );
    db.prepare("DELETE FROM todo_threads WHERE item_seq = ?").run(item.seq);
    for (const thread of bundle.threads) {
      db.prepare(
        "INSERT INTO todo_threads (item_seq, thread_id, note, linked_at) VALUES (?, ?, ?, ?)",
      ).run(thread.item_seq, thread.thread_id, thread.note, thread.linked_at);
    }
  };

  const restoreBundles = (bundles: ItemSnapshot[]) => {
    const seqs = bundles.map((bundle) => bundle.item.seq);
    const logIds = bundles.flatMap((bundle) => bundle.logs.map((log) => log.id));
    if (seqs.length === 0) return;
    const seqPlaceholders = seqs.map(() => "?").join(", ");
    db.prepare(`DELETE FROM todo_threads WHERE item_seq IN (${seqPlaceholders})`).run(...seqs);
    if (logIds.length > 0) {
      const logPlaceholders = logIds.map(() => "?").join(", ");
      db.prepare(
        `DELETE FROM todo_logs WHERE item_seq IN (${seqPlaceholders}) OR id IN (${logPlaceholders})`,
      ).run(...seqs, ...logIds);
    } else {
      db.prepare(`DELETE FROM todo_logs WHERE item_seq IN (${seqPlaceholders})`).run(...seqs);
    }
    for (const bundle of bundles) {
      upsertBundle(bundle);
      for (const log of bundle.logs) {
        db.prepare(
          "INSERT INTO todo_logs (id, item_seq, text, thread_id, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(log.id, log.item_seq, log.text, log.thread_id, log.created_at);
      }
    }
  };

  const softDelete = (seq: number, timestamp: string) => {
    db.prepare(
      "UPDATE todo_items SET deleted_at = ?, updated_at = ? WHERE seq = ? AND deleted_at IS NULL",
    ).run(timestamp, timestamp, seq);
  };

  const usedColors = (): Set<string> =>
    new Set(
      (db.prepare("SELECT color FROM todo_list_meta").all() as { color: string }[]).map(
        (row) => row.color,
      ),
    );

  const ensureListColor = (listName: string, explicit?: TodoColor) => {
    if (listName.length === 0) return;
    const existing = db
      .prepare("SELECT color FROM todo_list_meta WHERE list_name = ?")
      .get(listName) as { color: string } | undefined;
    if (existing && explicit === undefined) return;
    const color =
      explicit ??
      (TODO_COLORS.find((candidate) => !usedColors().has(candidate)) ?? fallbackTodoColor(listName));
    db.prepare(
      `INSERT INTO todo_list_meta (list_name, color, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(list_name) DO UPDATE SET color = excluded.color, updated_at = excluded.updated_at`,
    ).run(listName, color, now());
  };

  const colorFor = (listName: string): TodoColor => {
    const existing = db
      .prepare("SELECT color FROM todo_list_meta WHERE list_name = ?")
      .get(listName) as { color: string } | undefined;
    if (existing && todoColorSchema.safeParse(existing.color).success) {
      return existing.color as TodoColor;
    }
    ensureListColor(listName);
    const created = db
      .prepare("SELECT color FROM todo_list_meta WHERE list_name = ?")
      .get(listName) as { color: string } | undefined;
    return (created?.color as TodoColor | undefined) ?? fallbackTodoColor(listName);
  };

  const summarizeLists = (rows: ItemRow[]): TodoListSummary[] => {
    const groups = new Map<
      string,
      { firstSeq: number; count: number; sections: Map<string, number> }
    >();
    for (const row of rows) {
      if (row.list_name.length === 0) continue;
      const group = groups.get(row.list_name) ?? {
        firstSeq: row.seq,
        count: 0,
        sections: new Map<string, number>(),
      };
      group.count += 1;
      group.firstSeq = Math.min(group.firstSeq, row.seq);
      if (row.section_name.length > 0) {
        const seen = group.sections.get(row.section_name);
        group.sections.set(
          row.section_name,
          seen === undefined ? row.seq : Math.min(seen, row.seq),
        );
      }
      groups.set(row.list_name, group);
    }
    return [...groups.entries()]
      .sort((left, right) => left[1].firstSeq - right[1].firstSeq || left[0].localeCompare(right[0]))
      .map(([name, group]) =>
        todoListSummarySchema.parse({
          name,
          color: colorFor(name),
          openCount: group.count,
          sections: [...group.sections.entries()]
            .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
            .map(([section]) => section),
        }),
      );
  };

  const mustParseId = (id: string): number => {
    const seq = parseTodoId(id);
    if (seq === null) {
      throw new TodoError(`Invalid todo id: ${id}`, "invalid_id", "Use a todo id like T-1, t-1, or 1.");
    }
    return seq;
  };

  const readEnrichedItem = async (seq: number): Promise<TodoItem | null> => {
    const row = itemRow(seq);
    if (!row) return null;
    const [item] = await readRows([row]);
    return item ?? null;
  };

  const countOpenByBucket = (): TodoCounts => {
    const grouped = db
      .prepare(
        `SELECT bucket, count(*) AS total FROM todo_items WHERE completed_at IS NULL AND ${activeSql} GROUP BY bucket`,
      )
      .all() as { bucket: TodoBucket; total: number }[];
    const byBucket = new Map(grouped.map((row) => [row.bucket, Number(row.total)]));
    const focus = byBucket.get("focus") ?? 0;
    const later = byBucket.get("later") ?? 0;
    const waiting = byBucket.get("waiting") ?? 0;
    const doneRow = db
      .prepare(`SELECT count(*) AS total FROM todo_items WHERE completed_at IS NOT NULL AND ${activeSql}`)
      .get() as { total: number };
    return todoCountsSchema.parse({
      inbox: byBucket.get("inbox") ?? 0,
      focus,
      later,
      waiting,
      open: focus + later + waiting,
      done: Number(doneRow.total),
    });
  };

  const insertLog = (seq: number, text: string, threadId: string | null, timestamp: string) => {
    db.prepare(
      "INSERT INTO todo_logs (item_seq, text, thread_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(seq, text, threadId, timestamp);
  };

  // An empty note only inserts a missing link. It never clears a note that is
  // already there. Merge passes "fill" so a non-empty source note is copied
  // only when the target's note is still empty; an explicit link can replace it.
  const linkThreadRow = (
    seq: number,
    threadId: string,
    note: string | undefined,
    timestamp: string,
    mode: "set" | "fill" = "set",
  ) => {
    const trimmed = note?.trim() ?? "";
    const existing = db
      .prepare("SELECT note FROM todo_threads WHERE item_seq = ? AND thread_id = ?")
      .get(seq, threadId) as { note: string } | undefined;
    if (!existing) {
      db.prepare(
        "INSERT INTO todo_threads (item_seq, thread_id, note, linked_at) VALUES (?, ?, ?, ?)",
      ).run(seq, threadId, trimmed, timestamp);
      return;
    }
    if (trimmed.length === 0) return;
    if (mode === "fill" && existing.note.trim().length > 0) return;
    if (existing.note === trimmed) return;
    db.prepare("UPDATE todo_threads SET note = ? WHERE item_seq = ? AND thread_id = ?").run(
      trimmed,
      seq,
      threadId,
    );
  };

  const createTodo = async (input: CreateTodoInput, actor: string): Promise<TodoItem> => {
    const placement = resolveTodoPlacement(input.title, {
      listName: input.listName,
      sectionName: input.sectionName,
    });
    if (placement.title.length === 0) {
      throw new TodoError("Todo title is empty", "invalid_input", "Write a title after the #list prefix.");
    }
    const timestamp = now();
    const seq = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO todo_items
            (title, bucket, notes, next_step, proposal_reason, completed_at, sort_order, created_at, updated_at, list_name, section_name)
           VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)`,
        )
        .run(
          placement.title,
          input.bucket,
          input.notes,
          input.nextStep,
          input.proposalReason ?? null,
          timestamp,
          timestamp,
          placement.listName,
          placement.sectionName,
        );
      const createdSeq = Number(result.lastInsertRowid);
      if (input.threadId) linkThreadRow(createdSeq, input.threadId, undefined, timestamp);
      if (placement.listName.length > 0) ensureListColor(placement.listName);
      const placed = placement.listName.length > 0 ? ` 到 ${placement.listName}` : "";
      const section = placement.sectionName.length > 0 ? ` / ${placement.sectionName}` : "";
      writeRevision({
        seq: createdSeq,
        action: "create",
        actor,
        summary: `新增 ${formatTodoId(createdSeq)}${clipQuote(placement.title)}${placed}${section}`,
        before: null,
        after: [captureBundle(createdSeq)!],
        timestamp,
      });
      return createdSeq;
    })();
    publishChanged("created", seq);
    return (await readEnrichedItem(seq))!;
  };

  const updateTodo = async (id: string, values: UpdateTodoValues, actor: string): Promise<TodoItem> => {
    const seq = mustParseId(id);
    const row = requireItemRow(seq);
    if (row.bucket === "inbox") {
      throw new TodoError(
        `${formatTodoId(seq)} is an inbox proposal`,
        "not_editable",
        "Accept, merge, or dismiss it with `bb todo triage` first.",
      );
    }
    const fields: string[] = [];
    const valuesToBind: (string | number)[] = [];
    if (values.title !== undefined) {
      fields.push("title = ?");
      valuesToBind.push(values.title);
    }
    if (values.bucket !== undefined) {
      fields.push("bucket = ?");
      valuesToBind.push(values.bucket);
    }
    if (values.notes !== undefined) {
      fields.push("notes = ?");
      valuesToBind.push(values.notes);
    }
    if (values.nextStep !== undefined) {
      fields.push("next_step = ?");
      valuesToBind.push(values.nextStep);
    }
    if (values.listName !== undefined) {
      fields.push("list_name = ?");
      valuesToBind.push(values.listName);
    }
    if (values.sectionName !== undefined) {
      fields.push("section_name = ?");
      valuesToBind.push(values.sectionName);
    }
    if (values.sortOrder !== undefined) {
      fields.push("sort_order = ?");
      valuesToBind.push(values.sortOrder);
    }
    if (fields.length === 0) return (await readEnrichedItem(seq))!;
    const timestamp = now();
    db.transaction(() => {
      const before = captureBundle(seq);
      fields.push("updated_at = ?");
      valuesToBind.push(timestamp);
      db.prepare(`UPDATE todo_items SET ${fields.join(", ")} WHERE seq = ?`).run(
        ...valuesToBind,
        seq,
      );
      const nextList = values.listName ?? row.list_name;
      if (nextList.length > 0) ensureListColor(nextList);
      writeRevision({
        seq,
        action: "update",
        actor,
        summary: `修改 ${formatTodoId(seq)}${clipQuote(values.title ?? row.title)}`,
        before: before ? [before] : null,
        after: [captureBundle(seq)!],
        timestamp,
      });
    })();
    publishChanged("updated", seq);
    return (await readEnrichedItem(seq))!;
  };

  const setCompleted = async (
    id: string,
    completed: boolean,
    note: string | undefined,
    actor: string,
  ): Promise<TodoItem> => {
    const seq = mustParseId(id);
    const row = requireItemRow(seq);
    if (row.bucket === "inbox") {
      throw new TodoError(
        `${formatTodoId(seq)} is an inbox proposal`,
        "not_completable",
        "Accept it with `bb todo triage` before completing it.",
      );
    }
    const timestamp = now();
    if (completed) {
      if (row.completed_at === null) {
        db.transaction(() => {
          const before = captureBundle(seq);
          db.prepare("UPDATE todo_items SET completed_at = ?, updated_at = ? WHERE seq = ?").run(
            timestamp,
            timestamp,
            seq,
          );
          if (note) insertLog(seq, note, null, timestamp);
          writeRevision({
            seq,
            action: "complete",
            actor,
            summary: `勾选完成 ${formatTodoId(seq)}`,
            before: before ? [before] : null,
            after: [captureBundle(seq)!],
            timestamp,
          });
        })();
        publishChanged("completed", seq);
      }
    } else if (row.completed_at !== null) {
      db.transaction(() => {
        const before = captureBundle(seq);
        db.prepare("UPDATE todo_items SET completed_at = NULL, updated_at = ? WHERE seq = ?").run(
          timestamp,
          seq,
        );
        writeRevision({
          seq,
          action: "reopen",
          actor,
          summary: `重新打开 ${formatTodoId(seq)}`,
          before: before ? [before] : null,
          after: [captureBundle(seq)!],
          timestamp,
        });
      })();
      publishChanged("reopened", seq);
    }
    return (await readEnrichedItem(seq))!;
  };

  const triageInbox = async (
    input: z.infer<typeof triageInboxInput>,
    actor: string,
  ): Promise<{ action: TriageAction; item: TodoItem | null }> => {
    const seq = mustParseId(input.id);
    const source = requireItemRow(seq);
    if (source.bucket !== "inbox") {
      throw new TodoError(
        `${formatTodoId(seq)} is not an inbox proposal`,
        "not_inbox",
        "Only items proposed into the inbox can be triaged.",
      );
    }
    const timestamp = now();
    if (input.action === "dismiss") {
      db.transaction(() => {
        const before = captureBundle(seq);
        softDelete(seq, timestamp);
        writeRevision({
          seq,
          action: "triage_dismiss",
          actor,
          summary: `忽略 ${formatTodoId(seq)}${clipQuote(source.title)}`,
          before: before ? [before] : null,
          after: [captureBundle(seq)!],
          timestamp,
        });
      })();
      publishChanged("dismissed", seq);
      return { action: "dismiss", item: null };
    }
    if (input.action === "accept") {
      const bucket = input.bucket ?? "focus";
      const listName = input.listName !== undefined ? input.listName : source.list_name;
      const sectionName = input.sectionName !== undefined ? input.sectionName : source.section_name;
      db.transaction(() => {
        const before = captureBundle(seq);
        if (source.proposal_reason) {
          insertLog(seq, `Accepted from inbox: ${source.proposal_reason}`, null, timestamp);
        }
        db.prepare(
          `UPDATE todo_items
           SET bucket = ?, proposal_reason = NULL, list_name = ?, section_name = ?, updated_at = ?
           WHERE seq = ?`,
        ).run(bucket, listName, sectionName, timestamp, seq);
        if (listName.length > 0) ensureListColor(listName);
        writeRevision({
          seq,
          action: "triage_accept",
          actor,
          summary: `采纳 ${formatTodoId(seq)} 到 ${bucket}`,
          before: before ? [before] : null,
          after: [captureBundle(seq)!],
          timestamp,
        });
      })();
      publishChanged("triaged", seq);
      return { action: "accept", item: (await readEnrichedItem(seq))! };
    }
    if (input.intoId === undefined) {
      throw new TodoError(
        "Merging an inbox proposal requires a target todo",
        "missing_into",
        "Pass the target with `--into <target-id>`.",
      );
    }
    const targetSeq = mustParseId(input.intoId);
    if (targetSeq === seq) {
      throw new TodoError("A todo cannot be merged into itself", "merge_self", "Pass a different --into target.");
    }
    const target = requireItemRow(targetSeq);
    if (target.completed_at !== null) {
      throw new TodoError(
        `Merge target is completed: ${formatTodoId(targetSeq)}`,
        "merge_target_completed",
        "Reopen the target before merging into it.",
      );
    }
    if (target.bucket === "inbox") {
      throw new TodoError(
        `Merge target is still in the inbox: ${formatTodoId(targetSeq)}`,
        "merge_target_inbox",
        "Triage the target first, then merge into it.",
      );
    }
    const mergedLog = [`Merged inbox proposal: ${source.title}`];
    if (source.proposal_reason) mergedLog.push(`Reason: ${source.proposal_reason}`);
    if (source.notes) mergedLog.push(`Notes: ${source.notes}`);
    if (source.next_step.trim().length > 0) mergedLog.push(`Next step: ${source.next_step}`);
    const inheritedNextStep =
      target.next_step.trim().length === 0 && source.next_step.trim().length > 0
        ? source.next_step
        : target.next_step;
    db.transaction(() => {
      const beforeSource = captureBundle(seq);
      const beforeTarget = captureBundle(targetSeq);
      db.prepare("UPDATE todo_logs SET item_seq = ? WHERE item_seq = ?").run(targetSeq, seq);
      insertLog(targetSeq, mergedLog.join("\n"), null, timestamp);
      const linked = db
        .prepare("SELECT thread_id, note, linked_at FROM todo_threads WHERE item_seq = ?")
        .all(seq) as { thread_id: string; note: string; linked_at: string }[];
      for (const link of linked) {
        linkThreadRow(targetSeq, link.thread_id, link.note, timestamp, "fill");
      }
      db.prepare("UPDATE todo_items SET next_step = ?, updated_at = ? WHERE seq = ?").run(
        inheritedNextStep,
        timestamp,
        targetSeq,
      );
      softDelete(seq, timestamp);
      const after = [captureBundle(seq), captureBundle(targetSeq)].filter(
        (bundle): bundle is ItemSnapshot => bundle !== null,
      );
      writeRevision({
        seq: targetSeq,
        action: "triage_merge",
        actor,
        summary: `合并 ${formatTodoId(seq)} 至 ${formatTodoId(targetSeq)}`,
        before: [beforeSource, beforeTarget].filter((bundle): bundle is ItemSnapshot => bundle !== null),
        after,
        timestamp,
      });
    })();
    publishChanged("merged", targetSeq);
    return { action: "merge", item: (await readEnrichedItem(targetSeq))! };
  };

  const addLog = async (
    input: z.infer<typeof addTodoLogInput>,
  ): Promise<TodoItem> => {
    const seq = mustParseId(input.id);
    requireItemRow(seq);
    const threadId = input.threadId ?? null;
    const timestamp = now();
    db.transaction(() => {
      insertLog(seq, input.text, threadId, timestamp);
      if (input.nextStep !== undefined) {
        db.prepare("UPDATE todo_items SET next_step = ?, updated_at = ? WHERE seq = ?").run(
          input.nextStep,
          timestamp,
          seq,
        );
      } else {
        db.prepare("UPDATE todo_items SET updated_at = ? WHERE seq = ?").run(timestamp, seq);
      }
      if (threadId) linkThreadRow(seq, threadId, undefined, timestamp);
    })();
    publishChanged("logged", seq);
    return (await readEnrichedItem(seq))!;
  };

  const linkThread = async (
    input: z.infer<typeof linkTodoThreadInput>,
  ): Promise<TodoItem> => {
    const seq = mustParseId(input.id);
    requireItemRow(seq);
    const timestamp = now();
    linkThreadRow(seq, input.threadId, input.note, timestamp);
    db.prepare("UPDATE todo_items SET updated_at = ? WHERE seq = ?").run(timestamp, seq);
    publishChanged("linked", seq);
    return (await readEnrichedItem(seq))!;
  };

  const unlinkThread = async (
    input: z.infer<typeof unlinkTodoThreadInput>,
  ): Promise<TodoItem> => {
    const seq = mustParseId(input.id);
    requireItemRow(seq);
    const removed = db
      .prepare("DELETE FROM todo_threads WHERE item_seq = ? AND thread_id = ?")
      .run(seq, input.threadId).changes;
    if (removed > 0) {
      const timestamp = now();
      db.prepare("UPDATE todo_items SET updated_at = ? WHERE seq = ?").run(timestamp, seq);
      publishChanged("unlinked", seq);
    }
    return (await readEnrichedItem(seq))!;
  };

  const removeTodo = (seq: number, actor: string): { removed: boolean } => {
    const row = itemRow(seq);
    if (!row || row.deleted_at !== null) return { removed: false };
    const timestamp = now();
    db.transaction(() => {
      const before = captureBundle(seq);
      softDelete(seq, timestamp);
      writeRevision({
        seq,
        action: "delete",
        actor,
        summary: `删除 ${formatTodoId(seq)}${clipQuote(row.title)}`,
        before: before ? [before] : null,
        after: [captureBundle(seq)!],
        timestamp,
      });
    })();
    publishChanged("removed", seq);
    return { removed: true };
  };

  const showTodo = async (id: string): Promise<TodoItem | null> => {
    const seq = parseTodoId(id);
    if (seq === null) return null;
    const row = itemRow(seq);
    if (!row || row.deleted_at !== null) return null;
    return readEnrichedItem(seq);
  };

  const listItems = async (
    status: TodoListStatus,
    bucket: TodoBucket | undefined,
    search: string,
    listName?: string,
    sectionName?: string,
  ): Promise<TodoItem[]> => {
    const clauses: string[] = [activeSql];
    const params: string[] = [];
    if (status === "open") {
      clauses.push("completed_at IS NULL", "bucket <> 'inbox'");
    } else if (status === "inbox") {
      clauses.push("completed_at IS NULL", "bucket = 'inbox'");
    } else if (status === "done") {
      clauses.push("completed_at IS NOT NULL");
    }
    if (listName !== undefined && listName.length > 0) {
      clauses.push("list_name = ?");
      params.push(listName);
    }
    if (sectionName !== undefined && sectionName.length > 0) {
      clauses.push("section_name = ?");
      params.push(sectionName);
    }
    if (bucket !== undefined) {
      clauses.push("bucket = ?");
      params.push(bucket);
    }
    if (search.length > 0) {
      const term = `%${escapeLikePattern(search)}%`;
      clauses.push(
        "(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR next_step LIKE ? ESCAPE '\\')",
      );
      params.push(term, term, term);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const order =
      status === "done"
        ? "completed_at DESC, seq DESC"
        : status === "inbox"
          ? "seq DESC"
          : `CASE bucket WHEN 'focus' THEN 0 WHEN 'later' THEN 1 WHEN 'waiting' THEN 2 WHEN 'inbox' THEN 3 ELSE 4 END,
             CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END,
             sort_order ASC, seq ASC`;
    const rows = db
      .prepare(`SELECT * FROM todo_items ${where} ORDER BY ${order}`)
      .all(...params) as ItemRow[];
    return readRows(rows);
  };

  const listSnapshot = async (): Promise<TodoSnapshot> => {
    const openRows = db
      .prepare(
        `SELECT * FROM todo_items
         WHERE completed_at IS NULL AND bucket <> 'inbox' AND ${activeSql}
         ORDER BY CASE bucket WHEN 'focus' THEN 0 WHEN 'later' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
                  sort_order ASC, seq ASC`,
      )
      .all() as ItemRow[];
    const inboxRows = db
      .prepare(
        `SELECT * FROM todo_items WHERE completed_at IS NULL AND bucket = 'inbox' AND ${activeSql} ORDER BY seq DESC`,
      )
      .all() as ItemRow[];
    const doneRows = db
      .prepare(
        `SELECT * FROM todo_items WHERE completed_at IS NOT NULL AND ${activeSql} ORDER BY completed_at DESC, seq DESC LIMIT ?`,
      )
      .all(TODO_DONE_SNAPSHOT_LIMIT) as ItemRow[];
    const items = await readRows([...openRows, ...inboxRows, ...doneRows]);
    const bySeq = new Map(items.map((item) => [item.seq, item]));
    const pick = (rows: ItemRow[]) => rows.map((row) => bySeq.get(row.seq)!);
    return todoSnapshotSchema.parse({
      buckets: {
        focus: pick(openRows.filter((row) => row.bucket === "focus")),
        later: pick(openRows.filter((row) => row.bucket === "later")),
        waiting: pick(openRows.filter((row) => row.bucket === "waiting")),
        inbox: pick(inboxRows),
      },
      done: pick(doneRows),
      counts: countOpenByBucket(),
      lists: summarizeLists(openRows),
    });
  };

  const scanTodos = async (listName?: string, sectionName?: string): Promise<TodoScanResult> => {
    const inboxRow = db
      .prepare(
        `SELECT count(*) AS total FROM todo_items WHERE completed_at IS NULL AND bucket = 'inbox' AND ${activeSql}`,
      )
      .get() as { total: number };
    const clauses = ["completed_at IS NULL", "bucket <> 'inbox'", activeSql];
    const params: string[] = [];
    if (listName !== undefined && listName.length > 0) {
      clauses.push("list_name = ?");
      params.push(listName);
    }
    if (sectionName !== undefined && sectionName.length > 0) {
      clauses.push("section_name = ?");
      params.push(sectionName);
    }
    const rows = db
      .prepare(
        `SELECT * FROM todo_items
         WHERE ${clauses.join(" AND ")}
         ORDER BY CASE bucket WHEN 'focus' THEN 0 WHEN 'later' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
                  sort_order ASC, seq ASC`,
      )
      .all(...params) as ItemRow[];
    const items = await readRows(rows);
    return todoScanResultSchema.parse({
      inboxCount: Number(inboxRow.total),
      items: items.map((item) => {
        const hasRunningThread = item.threads.some(
          (thread) => thread.threadStatus === "active" || thread.threadStatus === "starting",
        );
        return {
          id: item.id,
          seq: item.seq,
          title: item.title,
          bucket: item.bucket as TodoFormalBucket,
          listName: item.listName,
          sectionName: item.sectionName,
          nextStep: item.nextStep,
          latestLog: item.logs[0] ?? null,
          threads: item.threads,
          hasRunningThread,
          actionable: item.bucket !== "waiting" && !hasRunningThread,
          updatedAt: item.updatedAt,
        };
      }),
    });
  };

  const prepareStartSession = async (id: string) => {
    const seq = mustParseId(id);
    const [item] = await readRows([requireItemRow(seq)]);
    if (!item) {
      throw new TodoError(
        `Todo not found: ${formatTodoId(seq)}`,
        "not_found",
        "Run `bb todo list --status all --json` to list ids.",
      );
    }
    const selected = selectPromptThreads(item.threads);
    const promptThreads = await Promise.all(
      selected.map(async (thread) => {
        try {
          const result = await bb.sdk.threads.output({ threadId: thread.threadId });
          return {
            threadId: thread.threadId,
            outputTail: summarizeThreadOutput(result.output),
          };
        } catch {
          return { threadId: thread.threadId, outputTail: null };
        }
      }),
    );
    const environment = recommendStartEnvironment(item.threads);
    return prepareStartSessionOutput.parse({
      itemId: item.id,
      title: item.title,
      projectId: environment.projectId,
      environmentId: environment.environmentId,
      initialPrompt: buildStartPrompt(
        item,
        promptThreads,
        item.threads.length - selected.length,
      ),
      relatedThreadCount: selected.length,
    });
  };

  const startTodoSession = async (
    id: string,
    options: { projectId?: string; extraPrompt?: string; fallbackProjectId?: string },
  ) => {
    const prepared = await prepareStartSession(id);
    const projectId =
      options.projectId?.trim() || prepared.projectId || options.fallbackProjectId?.trim() || "";
    if (projectId.length === 0) {
      throw new TodoError(
        "Starting a session needs a project",
        "missing_project",
        "Pass --project <projectId>. A linked thread's project, then the current bb project, are used when set.",
      );
    }
    const extra = options.extraPrompt?.trim() ?? "";
    const prompt = extra.length > 0 ? `${prepared.initialPrompt}\n\n${extra}` : prepared.initialPrompt;
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      title: `${prepared.itemId}: ${prepared.title}`.slice(0, 80),
      prompt,
    });
    const seq = mustParseId(prepared.itemId);
    const timestamp = now();
    db.transaction(() => {
      linkThreadRow(seq, thread.id, undefined, timestamp);
      insertLog(seq, `已开启会话 ${thread.id}`, thread.id, timestamp);
      db.prepare("UPDATE todo_items SET updated_at = ? WHERE seq = ?").run(timestamp, seq);
    })();
    publishChanged("started", seq);
    return {
      threadId: thread.id,
      projectId,
      initialPrompt: prompt,
      item: (await readEnrichedItem(seq))!,
    };
  };

  const listRevisions = (limit = TODO_REVISION_LIMIT_DEFAULT): TodoRevision[] => {
    const rows = db
      .prepare(
        `SELECT rev, item_seq, action, actor, summary, undone_at, created_at
         FROM todo_revisions ORDER BY rev DESC LIMIT ?`,
      )
      .all(limit) as {
      rev: number;
      item_seq: number;
      action: TodoRevisionAction;
      actor: string;
      summary: string;
      undone_at: string | null;
      created_at: string;
    }[];
    return rows.map((row) =>
      todoRevisionSchema.parse({
        rev: row.rev,
        itemSeq: row.item_seq,
        itemId: formatTodoId(row.item_seq),
        action: row.action,
        actor: row.actor,
        summary: row.summary,
        undoneAt: row.undone_at,
        createdAt: row.created_at,
      }),
    );
  };

  const undoRevision = (rev: number | undefined, actor: string) => {
    const row = (
      rev === undefined
        ? db
            .prepare(
              `SELECT rev, item_seq, action, actor, summary, before_snapshot, after_snapshot, undone_at
               FROM todo_revisions
               WHERE undone_at IS NULL AND action <> 'undo'
               ORDER BY rev DESC LIMIT 1`,
            )
            .get()
        : db
            .prepare(
              `SELECT rev, item_seq, action, actor, summary, before_snapshot, after_snapshot, undone_at
               FROM todo_revisions WHERE rev = ?`,
            )
            .get(rev)
    ) as
      | {
          rev: number;
          item_seq: number;
          action: string;
          summary: string;
          before_snapshot: string | null;
          after_snapshot: string | null;
          undone_at: string | null;
        }
      | undefined;
    if (!row) {
      throw new TodoError(
        rev === undefined ? "Nothing to undo" : `Revision not found: ${rev}`,
        rev === undefined ? "nothing_to_undo" : "not_found",
        rev === undefined
          ? "Run `bb todo history` to see recorded changes."
          : "Pass a revision from `bb todo history`.",
      );
    }
    if (row.action === "undo") {
      throw new TodoError(
        `Revision ${row.rev} is itself an undo`,
        "not_undoable",
        "Undo a create, update, complete, triage, or delete revision.",
      );
    }
    if (row.undone_at !== null) {
      throw new TodoError(
        `Revision ${row.rev} was already undone`,
        "already_undone",
        "Run `bb todo history` and pick a revision that is still active.",
      );
    }
    const before = decodeSnapshot(row.before_snapshot);
    const after = decodeSnapshot(row.after_snapshot);
    const timestamp = now();
    const undone = db.transaction(() => {
      if (before && before.length > 0) restoreBundles(before);
      else {
        for (const bundle of after ?? []) softDelete(bundle.item.seq, timestamp);
      }
      db.prepare("UPDATE todo_revisions SET undone_at = ? WHERE rev = ?").run(timestamp, row.rev);
      const touched = (before && before.length > 0 ? before : (after ?? [])).map((bundle) => bundle.item.seq);
      const restored = touched
        .map((seq) => captureBundle(seq))
        .filter((bundle): bundle is ItemSnapshot => bundle !== null);
      writeRevision({
        seq: row.item_seq,
        action: "undo",
        actor,
        summary: `撤销 #${row.rev}：${row.summary}`,
        before: after,
        after: restored,
        timestamp,
      });
      const created = db
        .prepare("SELECT rev, item_seq, action, actor, summary, undone_at, created_at FROM todo_revisions WHERE rev = last_insert_rowid()")
        .get() as {
        rev: number;
        item_seq: number;
        action: TodoRevisionAction;
        actor: string;
        summary: string;
        undone_at: string | null;
        created_at: string;
      };
      return todoRevisionSchema.parse({
        rev: created.rev,
        itemSeq: created.item_seq,
        itemId: formatTodoId(created.item_seq),
        action: created.action,
        actor: created.actor,
        summary: created.summary,
        undoneAt: created.undone_at,
        createdAt: created.created_at,
      });
    })();
    publishChanged("undo", row.item_seq);
    return { undoneRev: row.rev, revision: undone };
  };

  const setListColor = (listName: string, color: TodoColor): TodoListSummary => {
    ensureListColor(listName, color);
    const openRows = db
      .prepare(
        `SELECT * FROM todo_items WHERE completed_at IS NULL AND bucket <> 'inbox' AND ${activeSql} AND list_name = ?`,
      )
      .all(listName) as ItemRow[];
    const summary = summarizeLists(openRows).find((list) => list.name === listName);
    publishChanged("recolored", openRows[0]?.seq ?? 1);
    return summary ?? todoListSummarySchema.parse({ name: listName, color, openCount: 0, sections: [] });
  };

  bb.rpc.register(rpcContract, {
    listSnapshot: () => listSnapshot(),
    quickAdd: (input) =>
      createTodo(
        {
          title: input.title,
          bucket: input.bucket,
          notes: "",
          nextStep: "",
          listName: input.listName,
          sectionName: input.sectionName,
        },
        "ui",
      ),
    update: (input) =>
      updateTodo(
        input.id,
        {
          title: input.title,
          bucket: input.bucket,
          notes: input.notes,
          nextStep: input.nextStep,
          listName: input.listName,
          sectionName: input.sectionName,
          sortOrder: input.sortOrder,
        },
        "ui",
      ),
    setCompleted: (input) => setCompleted(input.id, input.completed, input.note, "ui"),
    triageInbox: (input) => triageInbox(input, "ui"),
    addLog: (input) => addLog(input),
    linkThread: (input) => linkThread(input),
    unlinkThread: (input) => unlinkThread(input),
    remove: (input) => removeTodo(mustParseId(input.id), "ui"),
    prepareStartSession: (input) => prepareStartSession(input.id),
    setListColor: (input) => setListColor(input.listName, input.color),
    listRevisions: (input) => ({ revisions: listRevisions(input.limit) }),
    undoRevision: (input) => undoRevision(input.rev, "ui"),
  });

  const reply = (
    value: unknown,
    json: boolean,
    human: () => string,
  ): PluginCliResult => {
    const stdout = json ? JSON.stringify(value) : human();
    if (Buffer.byteLength(stdout, "utf8") > PLUGIN_CLI_OUTPUT_MAX_BYTES) {
      throw new PluginCliError("Output exceeds the plugin CLI limit", {
        code: "output_too_large",
        hint: "Narrow the filter, or show a single todo by id.",
      });
    }
    return { exitCode: 0, stdout };
  };

  const cliCall = async <T>(action: () => T | Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof TodoError) {
        throw new PluginCliError(error.message, {
          code: error.code,
          hint: error.hint,
        });
      }
      throw error;
    }
  };

  const notFound = (raw: string) =>
    new PluginCliError(`Todo not found: ${raw}`, {
      code: "not_found",
      hint: "Run `bb todo list --status all --json` to list ids.",
    });

  const requireCurrentThread = (ctx: PluginCliContext): string => {
    if (!ctx.threadId) {
      throw new PluginCliError("No current bb thread to link", {
        code: "missing_thread",
        hint: "Run this command inside a BB thread, or omit --link-current.",
      });
    }
    return ctx.threadId;
  };

  const resolveThreadId = (explicit: string | undefined, ctx: PluginCliContext): string => {
    const threadId = explicit?.trim() || ctx.threadId;
    if (!threadId) {
      throw new PluginCliError("No thread specified", {
        code: "missing_thread",
        hint: "Pass --thread <threadId>, or run this command inside a BB thread.",
      });
    }
    return threadId;
  };

  const humanItemSummary = (item: TodoItem): string => {
    const state = item.completedAt !== null ? "done" : item.bucket;
    const next = item.nextStep.length > 0 ? ` — next: ${item.nextStep}` : "";
    return `${item.id}  ${state}  ${item.title}${next}`;
  };

  const humanItemDetail = (item: TodoItem): string => {
    const lines = [`${item.id}  ${item.completedAt !== null ? "done" : item.bucket}  ${item.title}`];
    if (item.listName) lines.push(`list: ${item.listName}`);
    if (item.sectionName) lines.push(`section: ${item.sectionName}`);
    if (item.proposalReason) lines.push(`proposal: ${item.proposalReason}`);
    if (item.notes) lines.push(`notes: ${item.notes}`);
    if (item.nextStep) lines.push(`next: ${item.nextStep}`);
    lines.push(`created: ${item.createdAt}`, `updated: ${item.updatedAt}`);
    if (item.threads.length > 0) {
      lines.push("threads:");
      for (const thread of item.threads) {
        const title = thread.threadTitle ? ` (${thread.threadTitle})` : "";
        const status = thread.threadStatus ? ` [${thread.threadStatus}]` : "";
        const note = thread.note ? ` — ${thread.note}` : "";
        lines.push(`  ${thread.threadId}${title}${status}${note}`);
      }
    }
    if (item.logs.length > 0) {
      lines.push("logs:");
      for (const log of item.logs) {
        const thread = log.threadId ? ` ${log.threadId}` : "";
        lines.push(`  ${log.createdAt}${thread} ${log.text}`);
      }
    }
    return lines.join("\n");
  };

  const humanScan = (result: TodoScanResult): string => {
    const lines = [
      `Inbox: ${result.inboxCount} pending proposal${result.inboxCount === 1 ? "" : "s"}`,
    ];
    if (result.items.length === 0) {
      lines.push("No open todos.");
      return lines.join("\n");
    }
    for (const item of result.items) {
      const flag = item.actionable
        ? "actionable"
        : item.bucket === "waiting"
          ? "waiting"
          : "running";
      const place = item.listName
        ? `  ${item.listName}${item.sectionName ? `/${item.sectionName}` : ""}`
        : "";
      lines.push(`${item.id}  ${item.bucket}${place}  ${item.title}  [${flag}]`);
      if (item.nextStep) lines.push(`  next: ${item.nextStep}`);
      if (item.latestLog) lines.push(`  last log: ${item.latestLog.text}`);
      if (item.threads.length > 0) {
        lines.push(`  threads: ${item.threads.map((thread) => thread.threadId).join(", ")}`);
      }
    }
    return lines.join("\n");
  };

  bb.cli.register(
    defineCli({
      name: "todo",
      summary: "Lightweight macro todos with agent session links and inbox triage",
      description:
        "Humans create formal todos; agents propose macro work into the inbox, link sessions, and scan for actionable items.",
      commands: {
        add: cliCommand({
          summary: "Create a formal todo",
          description: "Creates a formal todo in focus (default), later, or waiting.",
          positionals: [
            { name: "title", description: `Todo title (1-${TODO_TITLE_MAX_LENGTH} characters)`, required: true },
          ],
          options: {
            bucket: {
              type: "enum",
              values: ["focus", "later", "waiting"],
              default: "focus",
              description: "Formal bucket for the new todo.",
            },
            notes: {
              type: "string",
              description: `Optional notes (at most ${TODO_NOTES_MAX_LENGTH} characters).`,
            },
            "next-step": {
              type: "string",
              description: `Optional next step (at most ${TODO_NEXT_STEP_MAX_LENGTH} characters).`,
            },
            "link-current": {
              type: "boolean",
              description: "Link the invoking bb thread to the new todo.",
            },
            list: {
              type: "string",
              description: "Project list name. Overrides a #List prefix in the title.",
            },
            section: {
              type: "string",
              description: "Section inside the list. Overrides a #List/Section prefix.",
            },
            json: jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const input = parseCli(quickAddCliInput, {
              title: positionals.title,
              bucket: options.bucket,
              notes: options.notes,
              nextStep: options["next-step"],
              threadId: options["link-current"] ? requireCurrentThread(ctx) : undefined,
              listName: options.list,
              sectionName: options.section,
            });
            const item = await cliCall(() =>
              createTodo(
                {
                  title: input.title,
                  bucket: input.bucket,
                  notes: input.notes,
                  nextStep: input.nextStep,
                  threadId: input.threadId,
                  listName: input.listName,
                  sectionName: input.sectionName,
                },
                revisionActor(ctx),
              ),
            );
            return reply(item, options.json, () => `Added ${item.id} (${item.bucket}): ${item.title}`);
          },
        }),

        propose: cliCommand({
          summary: "Propose a macro todo into the inbox for user triage",
          description:
            "Agents use this after checking existing todos; proposals always land in inbox and never appear in the default open list.",
          positionals: [
            { name: "title", description: `Proposed todo title (1-${TODO_TITLE_MAX_LENGTH} characters)`, required: true },
          ],
          options: {
            reason: {
              type: "string",
              required: true,
              description: `Source excerpt and why this is a separate workstream (at most ${TODO_PROPOSAL_REASON_MAX_LENGTH} characters).`,
            },
            notes: {
              type: "string",
              description: `Optional notes (at most ${TODO_NOTES_MAX_LENGTH} characters).`,
            },
            "next-step": {
              type: "string",
              description: `Optional next step (at most ${TODO_NEXT_STEP_MAX_LENGTH} characters).`,
            },
            "link-current": {
              type: "boolean",
              description: "Link the invoking bb thread to the proposal.",
            },
            list: {
              type: "string",
              description: "Suggested project list. Overrides a #List prefix in the title.",
            },
            section: {
              type: "string",
              description: "Suggested section. Overrides a #List/Section prefix.",
            },
            json: jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const input = parseCli(proposeTodoInput, {
              title: positionals.title,
              reason: options.reason,
              notes: options.notes,
              nextStep: options["next-step"],
              threadId: options["link-current"] ? requireCurrentThread(ctx) : undefined,
            });
            const placed = parseCli(
              z.object({
                listName: z.string().trim().max(80).optional(),
                sectionName: z.string().trim().max(80).optional(),
              }),
              { listName: options.list, sectionName: options.section },
            );
            const item = await cliCall(() =>
              createTodo(
                {
                  title: input.title,
                  bucket: "inbox",
                  notes: input.notes,
                  nextStep: input.nextStep,
                  proposalReason: input.reason,
                  threadId: input.threadId,
                  listName: placed.listName,
                  sectionName: placed.sectionName,
                },
                revisionActor(ctx),
              ),
            );
            return reply(item, options.json, () =>
              `Proposed ${item.id} (inbox): ${item.title}\nReason: ${item.proposalReason}`,
            );
          },
        }),

        triage: cliCommand({
          summary: "Accept, merge, or dismiss an inbox proposal",
          positionals: [
            { name: "id", description: "Inbox proposal id (T-1, t-1, or 1)", required: true },
          ],
          options: {
            action: {
              type: "enum",
              values: ["accept", "merge", "dismiss"],
              required: true,
              description: "What to do with the proposal.",
            },
            bucket: {
              type: "enum",
              values: ["focus", "later", "waiting"],
              description: "Accepted bucket; defaults to focus. Only valid with --action accept.",
            },
            into: {
              type: "string",
              description: "Target todo id. Required with --action merge.",
            },
            list: {
              type: "string",
              description: "Project list to apply when accepting.",
            },
            section: {
              type: "string",
              description: "Section to apply when accepting.",
            },
            json: jsonOption,
          },
          async run({ positionals, options }, ctx) {
            if (options.action === "merge" && options.into === undefined) {
              throw new PluginCliError("Merging an inbox proposal requires --into <target-id>", {
                code: "missing_into",
                hint: "Pick the existing macro todo with `bb todo list --json`, then pass its id.",
              });
            }
            if (options.action !== "merge" && options.into !== undefined) {
              throw new PluginCliError("--into is only valid with --action merge", {
                code: "invalid_combination",
                hint: "Remove --into, or change --action to merge.",
              });
            }
            if (options.action !== "accept" && options.bucket !== undefined) {
              throw new PluginCliError("--bucket is only valid with --action accept", {
                code: "invalid_combination",
                hint: "Remove --bucket, or change --action to accept.",
              });
            }
            if (options.action !== "accept" && (options.list !== undefined || options.section !== undefined)) {
              throw new PluginCliError("--list and --section are only valid with --action accept", {
                code: "invalid_combination",
                hint: "Remove --list and --section, or change --action to accept.",
              });
            }
            const input = parseCli(triageInboxInput, {
              id: cliTodoId(positionals.id),
              action: options.action,
              bucket: options.bucket,
              intoId: options.into === undefined ? undefined : cliTodoId(options.into),
              listName: options.list,
              sectionName: options.section,
            });
            const result = await cliCall(() => triageInbox(input, revisionActor(ctx)));
            const human =
              result.action === "dismiss"
                ? `Dismissed ${positionals.id}`
                : result.action === "merge"
                  ? `Merged ${positionals.id} into ${input.intoId}`
                  : `Accepted ${positionals.id} into ${result.item?.bucket ?? "focus"}`;
            return reply(result, options.json, () => human);
          },
        }),

        list: cliCommand({
          summary: "List todos by status, bucket, and search text",
          description:
            "Defaults to open formal todos ordered focus, later, waiting. Inbox proposals are excluded unless requested.",
          options: {
            status: {
              type: "enum",
              values: ["open", "inbox", "done", "all"],
              default: "open",
              description: "open = unfinished formal todos; inbox = pending proposals; all = everything.",
            },
            bucket: {
              type: "enum",
              values: ["focus", "later", "waiting", "inbox"],
              description: "Only todos in this bucket.",
            },
            search: {
              type: "string",
              description: "Case-insensitive text search over title, notes, and next step.",
            },
            list: {
              type: "string",
              description: "Only todos in this project list.",
            },
            section: {
              type: "string",
              description: "Only todos in this section.",
            },
            json: jsonOption,
          },
          async run({ options }) {
            const items = await cliCall(() =>
              listItems(options.status, options.bucket, options.search ?? "", options.list, options.section),
            );
            return reply({ items, count: items.length }, options.json, () =>
              items.length === 0 ? "No todos." : items.map(humanItemSummary).join("\n"),
            );
          },
        }),

        show: cliCommand({
          summary: "Show one todo with logs and enriched linked threads",
          positionals: [
            { name: "id", description: "Todo id (T-1, t-1, or 1)", required: true },
          ],
          options: { json: jsonOption },
          async run({ positionals, options }) {
            const item = await cliCall(() => showTodo(positionals.id));
            if (item === null) throw notFound(positionals.id);
            return reply(item, options.json, () => humanItemDetail(item));
          },
        }),

        update: cliCommand({
          summary: "Edit a formal todo or move it between formal buckets",
          positionals: [
            { name: "id", description: "Formal todo id (T-1, t-1, or 1)", required: true },
          ],
          options: {
            title: {
              type: "string",
              description: `New title (1-${TODO_TITLE_MAX_LENGTH} characters).`,
            },
            bucket: {
              type: "enum",
              values: ["focus", "later", "waiting"],
              description: "Move the todo to another formal bucket.",
            },
            notes: {
              type: "string",
              description: `Replace notes (at most ${TODO_NOTES_MAX_LENGTH} characters).`,
            },
            "next-step": {
              type: "string",
              description: `Replace next step (at most ${TODO_NEXT_STEP_MAX_LENGTH} characters).`,
            },
            list: {
              type: "string",
              description: "Move the todo to this project list. Pass an empty string to clear it.",
            },
            section: {
              type: "string",
              description: "Move the todo to this section. Pass an empty string to clear it.",
            },
            json: jsonOption,
          },
          async run({ positionals, options }, ctx) {
            if (
              options.title === undefined &&
              options.bucket === undefined &&
              options.notes === undefined &&
              options["next-step"] === undefined &&
              options.list === undefined &&
              options.section === undefined
            ) {
              throw new PluginCliError("No changes supplied", {
                code: "missing_change",
                hint: "Pass at least one of --title, --bucket, --notes, --next-step, --list, or --section.",
              });
            }
            const input = parseCli(updateTodoInput, {
              id: cliTodoId(positionals.id),
              title: options.title,
              bucket: options.bucket,
              notes: options.notes,
              nextStep: options["next-step"],
              listName: options.list,
              sectionName: options.section,
            });
            const item = await cliCall(() =>
              updateTodo(
                input.id,
                {
                  title: input.title,
                  bucket: input.bucket,
                  notes: input.notes,
                  nextStep: input.nextStep,
                  listName: input.listName,
                  sectionName: input.sectionName,
                  sortOrder: input.sortOrder,
                },
                revisionActor(ctx),
              ),
            );
            return reply(item, options.json, () => humanItemDetail(item));
          },
        }),

        done: cliCommand({
          summary: "Complete a formal todo",
          positionals: [
            { name: "id", description: "Formal todo id (T-1, t-1, or 1)", required: true },
          ],
          options: {
            note: {
              type: "string",
              description: `Optional completion log (at most ${TODO_LOG_TEXT_MAX_LENGTH} characters).`,
            },
            json: jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const input = parseCli(setTodoCompletedInput, {
              id: cliTodoId(positionals.id),
              completed: true,
              note: options.note,
            });
            const item = await cliCall(() =>
              setCompleted(input.id, input.completed, input.note, revisionActor(ctx)),
            );
            return reply(item, options.json, () => `Completed ${item.id}: ${item.title}`);
          },
        }),

        reopen: cliCommand({
          summary: "Reopen a completed todo",
          positionals: [
            { name: "id", description: "Completed todo id (T-1, t-1, or 1)", required: true },
          ],
          options: { json: jsonOption },
          async run({ positionals, options }, ctx) {
            const input = parseCli(setTodoCompletedInput, {
              id: cliTodoId(positionals.id),
              completed: false,
            });
            const item = await cliCall(() =>
              setCompleted(input.id, input.completed, undefined, revisionActor(ctx)),
            );
            return reply(item, options.json, () => `Reopened ${item.id}: ${item.title}`);
          },
        }),

        rm: cliCommand({
          summary: "Delete a todo",
          positionals: [
            { name: "id", description: "Todo id (T-1, t-1, or 1)", required: true },
          ],
          options: { json: jsonOption },
          async run({ positionals, options }, ctx) {
            const id = cliTodoId(positionals.id);
            const result = await cliCall(() => removeTodo(parseTodoId(id)!, revisionActor(ctx)));
            if (!result.removed) throw notFound(positionals.id);
            return reply({ id, removed: true }, options.json, () => `Removed ${id}`);
          },
        }),

        log: cliCommand({
          summary: "Append a progress log and optionally bind the current thread",
          description:
            "Inside a bb thread the invoking thread is recorded in the log and bound to the todo unless --no-link is passed.",
          positionals: [
            { name: "id", description: "Todo id (T-1, t-1, or 1)", required: true },
            { name: "text", description: `Log text (1-${TODO_LOG_TEXT_MAX_LENGTH} characters)`, required: true },
          ],
          options: {
            "next-step": {
              type: "string",
              description: `Replace next step (at most ${TODO_NEXT_STEP_MAX_LENGTH} characters).`,
            },
            "no-link": {
              type: "boolean",
              description: "Do not link the invoking bb thread to this todo.",
            },
            json: jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const threadId = options["no-link"] ? undefined : ctx.threadId;
            const input = parseCli(addTodoLogInput, {
              id: cliTodoId(positionals.id),
              text: positionals.text,
              nextStep: options["next-step"],
              threadId,
            });
            const item = await cliCall(() => addLog(input));
            return reply(item, options.json, () =>
              `Logged to ${item.id}${threadId ? ` (${threadId})` : ""}`,
            );
          },
        }),

        link: cliCommand({
          summary: "Link a bb thread to a todo",
          positionals: [
            { name: "id", description: "Todo id (T-1, t-1, or 1)", required: true },
          ],
          options: {
            thread: {
              type: "string",
              description: "Thread id; defaults to the invoking bb thread.",
            },
            note: {
              type: "string",
              description: `Optional note for this link (at most ${TODO_THREAD_NOTE_MAX_LENGTH} characters).`,
            },
            json: jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const input = parseCli(linkTodoThreadInput, {
              id: cliTodoId(positionals.id),
              threadId: resolveThreadId(options.thread, ctx),
              note: options.note,
            });
            const item = await cliCall(() => linkThread(input));
            return reply(item, options.json, () => `Linked ${item.id} to ${input.threadId}`);
          },
        }),

        unlink: cliCommand({
          summary: "Remove a bb thread link from a todo",
          positionals: [
            { name: "id", description: "Todo id (T-1, t-1, or 1)", required: true },
          ],
          options: {
            thread: {
              type: "string",
              description: "Thread id; defaults to the invoking bb thread.",
            },
            json: jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const threadId = resolveThreadId(options.thread, ctx);
            const input = parseCli(unlinkTodoThreadInput, {
              id: cliTodoId(positionals.id),
              threadId,
            });
            const item = await cliCall(() => unlinkThread(input));
            return reply(item, options.json, () => `Unlinked ${item.id} from ${threadId}`);
          },
        }),

        start: cliCommand({
          summary: "Start a new bb thread for a todo and link it",
          description:
            "Builds the same prompt as the panel's new-session action, spawns a thread in the chosen project, and links that thread back to the todo.",
          positionals: [
            { name: "id", description: "Todo id (T-1, t-1, or 1)", required: true },
          ],
          options: {
            project: {
              type: "string",
              description:
                "Project id. Defaults to the newest linked thread's project, then the current bb project.",
            },
            prompt: {
              type: "string",
              description: "Extra instruction appended to the generated prompt.",
            },
            json: jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const started = await cliCall(() =>
              startTodoSession(cliTodoId(positionals.id), {
                projectId: options.project,
                extraPrompt: options.prompt,
                fallbackProjectId: ctx.projectId,
              }),
            );
            return reply(
              started,
              options.json,
              () => `Started ${started.threadId} for ${started.item.id} in ${started.projectId}`,
            );
          },
        }),

        scan: cliCommand({
          summary: "Scan open formal todos for agent-driven progress",
          description:
            "Returns inboxCount plus every open formal todo with its next step, latest log, linked threads, hasRunningThread, and actionable flags. actionable = not waiting and no linked thread is active or starting.",
          options: {
            list: {
              type: "string",
              description: "Only todos in this project list.",
            },
            section: {
              type: "string",
              description: "Only todos in this section.",
            },
            json: jsonOption,
          },
          async run({ options }) {
            const result = await cliCall(() => scanTodos(options.list, options.section));
            return reply(result, options.json, () => humanScan(result));
          },
        }),

        color: cliCommand({
          summary: "Set a project list's color",
          positionals: [
            { name: "list", description: "Project list name", required: true },
            {
              name: "color",
              description: `One of ${TODO_COLORS.join(", ")}`,
              required: true,
            },
          ],
          options: { json: jsonOption },
          async run({ positionals, options }) {
            const color = todoColorSchema.safeParse(positionals.color);
            if (!color.success) {
              throw new PluginCliError(`Unknown list color: ${positionals.color}`, {
                code: "invalid_color",
                hint: `Use one of ${TODO_COLORS.join(", ")}.`,
              });
            }
            const summary = await cliCall(() => setListColor(positionals.list.trim(), color.data));
            return reply(summary, options.json, () => `${summary.name} is ${summary.color}`);
          },
        }),

        history: cliCommand({
          summary: "Show recent todo changes that can be undone",
          options: {
            limit: {
              type: "integer",
              min: 1,
              max: 100,
              default: TODO_REVISION_LIMIT_DEFAULT,
              description: "How many revisions to return (1-100, default 20).",
            },
            json: jsonOption,
          },
          async run({ options }) {
            const revisions = listRevisions(options.limit);
            return reply({ revisions }, options.json, () =>
              revisions.length === 0
                ? "No changes."
                : revisions
                    .map((revision) => {
                      const undone = revision.undoneAt ? " undone" : "";
                      return `#${revision.rev}  ${revision.createdAt}  ${revision.actor}  ${revision.summary}${undone}`;
                    })
                    .join("\n"),
            );
          },
        }),

        undo: cliCommand({
          summary: "Undo a recorded todo change",
          description:
            "Restores the items touched by that change. With no revision, undoes the latest change that is not itself an undo.",
          positionals: [
            { name: "rev", description: "Revision number from `bb todo history`", required: false },
          ],
          options: { json: jsonOption },
          async run({ positionals, options }, ctx) {
            let rev: number | undefined;
            if (positionals.rev !== undefined) {
              rev = Number(positionals.rev);
              if (!Number.isSafeInteger(rev) || rev < 1) {
                throw new PluginCliError(`Invalid revision: ${positionals.rev}`, {
                  code: "invalid_revision",
                  hint: "Pass a positive revision number from `bb todo history`.",
                });
              }
            }
            const result = await cliCall(() => undoRevision(rev, revisionActor(ctx)));
            return reply(result, options.json, () => result.revision.summary);
          },
        }),
      },
    }),
  );
}
