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
  TODO_DONE_SNAPSHOT_LIMIT,
  TODO_LOG_TEXT_MAX_LENGTH,
  TODO_NEXT_STEP_MAX_LENGTH,
  TODO_NOTES_MAX_LENGTH,
  TODO_PROPOSAL_REASON_MAX_LENGTH,
  TODO_THREAD_NOTE_MAX_LENGTH,
  TODO_TITLE_MAX_LENGTH,
  addTodoLogInput,
  formatTodoId,
  linkTodoThreadInput,
  parseTodoId,
  quickAddInput,
  rpcContract,
  setTodoCompletedInput,
  todoCountsSchema,
  todoScanResultSchema,
  todoSnapshotSchema,
  triageInboxInput,
  unlinkTodoThreadInput,
  updateTodoInput,
  type TriageAction,
  type TodoBucket,
  type TodoCounts,
  type TodoFormalBucket,
  type TodoItem,
  type TodoListStatus,
  type TodoLogEntry,
  type TodoScanResult,
  type TodoSnapshot,
  type TodoThreadLink,
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
  completed_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
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
};

type UpdateTodoValues = {
  title?: string;
  bucket?: TodoFormalBucket;
  notes?: string;
  nextStep?: string;
  sortOrder?: number;
};

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
  ]);

  const now = () => new Date().toISOString();

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
    completedAt: row.completed_at,
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
    const live = new Map<string, { title: string | null; status: string | null }>();
    await Promise.all(
      threadIds.map(async (threadId) => {
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          live.set(threadId, {
            title: thread.title || thread.titleFallback || null,
            status: thread.status ?? null,
          });
        } catch {
          // A deleted or unreachable thread must not hide the todo itself.
          live.set(threadId, { title: null, status: null });
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
    if (!row) {
      throw new TodoError(`Todo not found: ${formatTodoId(seq)}`, "not_found", "Run `bb todo list --status all --json` to list ids.");
    }
    return row;
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
        "SELECT bucket, count(*) AS total FROM todo_items WHERE completed_at IS NULL GROUP BY bucket",
      )
      .all() as { bucket: TodoBucket; total: number }[];
    const byBucket = new Map(grouped.map((row) => [row.bucket, Number(row.total)]));
    const focus = byBucket.get("focus") ?? 0;
    const later = byBucket.get("later") ?? 0;
    const waiting = byBucket.get("waiting") ?? 0;
    const doneRow = db
      .prepare("SELECT count(*) AS total FROM todo_items WHERE completed_at IS NOT NULL")
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

  const linkThreadRow = (
    seq: number,
    threadId: string,
    note: string | undefined,
    timestamp: string,
  ) => {
    if (note === undefined) {
      db.prepare(
        `INSERT INTO todo_threads (item_seq, thread_id, note, linked_at) VALUES (?, ?, '', ?)
         ON CONFLICT(item_seq, thread_id) DO NOTHING`,
      ).run(seq, threadId, timestamp);
      return;
    }
    db.prepare(
      `INSERT INTO todo_threads (item_seq, thread_id, note, linked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_seq, thread_id) DO UPDATE SET note = excluded.note`,
    ).run(seq, threadId, note, timestamp);
  };

  const deleteItemRow = (seq: number): boolean => {
    db.prepare("DELETE FROM todo_logs WHERE item_seq = ?").run(seq);
    db.prepare("DELETE FROM todo_threads WHERE item_seq = ?").run(seq);
    return db.prepare("DELETE FROM todo_items WHERE seq = ?").run(seq).changes > 0;
  };

  const createTodo = async (input: CreateTodoInput): Promise<TodoItem> => {
    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO todo_items
          (title, bucket, notes, next_step, proposal_reason, completed_at, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
      )
      .run(
        input.title,
        input.bucket,
        input.notes,
        input.nextStep,
        input.proposalReason ?? null,
        timestamp,
        timestamp,
      );
    const seq = Number(result.lastInsertRowid);
    if (input.threadId) linkThreadRow(seq, input.threadId, undefined, timestamp);
    publishChanged("created", seq);
    return (await readEnrichedItem(seq))!;
  };

  const updateTodo = async (id: string, values: UpdateTodoValues): Promise<TodoItem> => {
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
    if (values.sortOrder !== undefined) {
      fields.push("sort_order = ?");
      valuesToBind.push(values.sortOrder);
    }
    if (fields.length === 0) return (await readEnrichedItem(seq))!;
    fields.push("updated_at = ?");
    valuesToBind.push(now());
    db.prepare(`UPDATE todo_items SET ${fields.join(", ")} WHERE seq = ?`).run(
      ...valuesToBind,
      seq,
    );
    publishChanged("updated", seq);
    return (await readEnrichedItem(seq))!;
  };

  const setCompleted = async (
    id: string,
    completed: boolean,
    note: string | undefined,
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
          db.prepare("UPDATE todo_items SET completed_at = ?, updated_at = ? WHERE seq = ?").run(
            timestamp,
            timestamp,
            seq,
          );
          if (note) insertLog(seq, note, null, timestamp);
        })();
        publishChanged("completed", seq);
      }
    } else if (row.completed_at !== null) {
      db.prepare("UPDATE todo_items SET completed_at = NULL, updated_at = ? WHERE seq = ?").run(
        timestamp,
        seq,
      );
      publishChanged("reopened", seq);
    }
    return (await readEnrichedItem(seq))!;
  };

  const triageInbox = async (
    input: z.infer<typeof triageInboxInput>,
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
      const removed = db.transaction(() => deleteItemRow(seq))();
      if (removed) publishChanged("dismissed", seq);
      return { action: "dismiss", item: null };
    }
    if (input.action === "accept") {
      const bucket = input.bucket ?? "focus";
      db.transaction(() => {
        if (source.proposal_reason) {
          insertLog(seq, `Accepted from inbox: ${source.proposal_reason}`, null, timestamp);
        }
        db.prepare(
          "UPDATE todo_items SET bucket = ?, proposal_reason = NULL, updated_at = ? WHERE seq = ?",
        ).run(bucket, timestamp, seq);
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
    db.transaction(() => {
      insertLog(targetSeq, mergedLog.join("\n"), null, timestamp);
      const linked = db
        .prepare("SELECT thread_id, note, linked_at FROM todo_threads WHERE item_seq = ?")
        .all(seq) as { thread_id: string; note: string; linked_at: string }[];
      for (const link of linked) {
        linkThreadRow(targetSeq, link.thread_id, link.note, timestamp);
      }
      db.prepare("UPDATE todo_items SET updated_at = ? WHERE seq = ?").run(timestamp, targetSeq);
      deleteItemRow(seq);
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

  const removeTodo = (seq: number): { removed: boolean } => {
    const removed = db.transaction(() => deleteItemRow(seq))();
    if (removed) publishChanged("removed", seq);
    return { removed };
  };

  const showTodo = async (id: string): Promise<TodoItem | null> => {
    const seq = parseTodoId(id);
    return seq === null ? null : readEnrichedItem(seq);
  };

  const listItems = async (
    status: TodoListStatus,
    bucket: TodoBucket | undefined,
    search: string,
  ): Promise<TodoItem[]> => {
    const clauses: string[] = [];
    const params: string[] = [];
    if (status === "open") {
      clauses.push("completed_at IS NULL", "bucket <> 'inbox'");
    } else if (status === "inbox") {
      clauses.push("completed_at IS NULL", "bucket = 'inbox'");
    } else if (status === "done") {
      clauses.push("completed_at IS NOT NULL");
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
         WHERE completed_at IS NULL AND bucket <> 'inbox'
         ORDER BY CASE bucket WHEN 'focus' THEN 0 WHEN 'later' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
                  sort_order ASC, seq ASC`,
      )
      .all() as ItemRow[];
    const inboxRows = db
      .prepare(
        "SELECT * FROM todo_items WHERE completed_at IS NULL AND bucket = 'inbox' ORDER BY seq DESC",
      )
      .all() as ItemRow[];
    const doneRows = db
      .prepare(
        "SELECT * FROM todo_items WHERE completed_at IS NOT NULL ORDER BY completed_at DESC, seq DESC LIMIT ?",
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
    });
  };

  const scanTodos = async (): Promise<TodoScanResult> => {
    const inboxRow = db
      .prepare("SELECT count(*) AS total FROM todo_items WHERE completed_at IS NULL AND bucket = 'inbox'")
      .get() as { total: number };
    const rows = db
      .prepare(
        `SELECT * FROM todo_items
         WHERE completed_at IS NULL AND bucket <> 'inbox'
         ORDER BY CASE bucket WHEN 'focus' THEN 0 WHEN 'later' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
                  sort_order ASC, seq ASC`,
      )
      .all() as ItemRow[];
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

  bb.rpc.register(rpcContract, {
    listSnapshot: () => listSnapshot(),
    quickAdd: (input) =>
      createTodo({
        title: input.title,
        bucket: input.bucket,
        notes: "",
        nextStep: "",
      }),
    update: (input) =>
      updateTodo(input.id, {
        title: input.title,
        bucket: input.bucket,
        notes: input.notes,
        nextStep: input.nextStep,
        sortOrder: input.sortOrder,
      }),
    setCompleted: (input) => setCompleted(input.id, input.completed, input.note),
    triageInbox: (input) => triageInbox(input),
    addLog: (input) => addLog(input),
    linkThread: (input) => linkThread(input),
    unlinkThread: (input) => unlinkThread(input),
    remove: (input) => removeTodo(mustParseId(input.id)),
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
      lines.push(`${item.id}  ${item.bucket}  ${item.title}  [${flag}]`);
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
            json: jsonOption,
          },
          async run({ positionals, options }, ctx) {
            const input = parseCli(quickAddCliInput, {
              title: positionals.title,
              bucket: options.bucket,
              notes: options.notes,
              nextStep: options["next-step"],
              threadId: options["link-current"] ? requireCurrentThread(ctx) : undefined,
            });
            const item = await cliCall(() =>
              createTodo({
                title: input.title,
                bucket: input.bucket,
                notes: input.notes,
                nextStep: input.nextStep,
                threadId: input.threadId,
              }),
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
            const item = await cliCall(() =>
              createTodo({
                title: input.title,
                bucket: "inbox",
                notes: input.notes,
                nextStep: input.nextStep,
                proposalReason: input.reason,
                threadId: input.threadId,
              }),
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
            json: jsonOption,
          },
          async run({ positionals, options }) {
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
            const input = parseCli(triageInboxInput, {
              id: cliTodoId(positionals.id),
              action: options.action,
              bucket: options.bucket,
              intoId: options.into === undefined ? undefined : cliTodoId(options.into),
            });
            const result = await cliCall(() => triageInbox(input));
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
            json: jsonOption,
          },
          async run({ options }) {
            const items = await cliCall(() =>
              listItems(options.status, options.bucket, options.search ?? ""),
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
            json: jsonOption,
          },
          async run({ positionals, options }) {
            if (
              options.title === undefined &&
              options.bucket === undefined &&
              options.notes === undefined &&
              options["next-step"] === undefined
            ) {
              throw new PluginCliError("No changes supplied", {
                code: "missing_change",
                hint: "Pass at least one of --title, --bucket, --notes, or --next-step.",
              });
            }
            const input = parseCli(updateTodoInput, {
              id: cliTodoId(positionals.id),
              title: options.title,
              bucket: options.bucket,
              notes: options.notes,
              nextStep: options["next-step"],
            });
            const item = await cliCall(() =>
              updateTodo(input.id, {
                title: input.title,
                bucket: input.bucket,
                notes: input.notes,
                nextStep: input.nextStep,
                sortOrder: input.sortOrder,
              }),
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
          async run({ positionals, options }) {
            const input = parseCli(setTodoCompletedInput, {
              id: cliTodoId(positionals.id),
              completed: true,
              note: options.note,
            });
            const item = await cliCall(() =>
              setCompleted(input.id, input.completed, input.note),
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
          async run({ positionals, options }) {
            const input = parseCli(setTodoCompletedInput, {
              id: cliTodoId(positionals.id),
              completed: false,
            });
            const item = await cliCall(() =>
              setCompleted(input.id, input.completed, undefined),
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
          async run({ positionals, options }) {
            const id = cliTodoId(positionals.id);
            const result = await cliCall(() => removeTodo(parseTodoId(id)!));
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

        scan: cliCommand({
          summary: "Scan open formal todos for agent-driven progress",
          description:
            "Returns inboxCount plus every open formal todo with its next step, latest log, linked threads, hasRunningThread, and actionable flags. actionable = not waiting and no linked thread is active or starting.",
          options: { json: jsonOption },
          async run({ options }) {
            const result = await cliCall(() => scanTodos());
            return reply(result, options.json, () => humanScan(result));
          },
        }),
      },
    }),
  );
}
