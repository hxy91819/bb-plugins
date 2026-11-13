import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Ephemeral realtime channel; every successful write publishes on it. */
export const TODO_CHANGED_EVENT = "todo:changed" as const;

export const TODO_FORMAL_BUCKETS = ["focus", "later", "waiting"] as const;
export const TODO_BUCKET_ORDER = ["focus", "later", "waiting", "inbox"] as const;

/** Apple Reminders-style palette. The first eight lists take these in order. */
export const TODO_COLORS = [
  "blue",
  "orange",
  "green",
  "purple",
  "rose",
  "teal",
  "amber",
  "indigo",
] as const;
export type TodoColor = (typeof TODO_COLORS)[number];

export const TODO_TITLE_MAX_LENGTH = 500;
export const TODO_NOTES_MAX_LENGTH = 20_000;
/**
 * Legacy compatibility only. Older automation still passes `--next-step`;
 * the server folds that text into `notes` instead of rejecting the command.
 * Nothing else exposes a separate next-step field.
 */
export const TODO_LEGACY_NEXT_STEP_MAX_LENGTH = 2_000;
export const TODO_LOG_TEXT_MAX_LENGTH = 4_000;
export const TODO_PROPOSAL_REASON_MAX_LENGTH = 2_000;
export const TODO_THREAD_NOTE_MAX_LENGTH = 1_000;
export const TODO_LIST_NAME_MAX_LENGTH = 80;
export const TODO_SECTION_NAME_MAX_LENGTH = 80;
export const TODO_REVISION_LIMIT_DEFAULT = 20;
export const TODO_REVISION_LIMIT_MAX = 100;
/** How many recently completed todos the panel snapshot includes. */
export const TODO_DONE_SNAPSHOT_LIMIT = 20;
/** Linked threads quoted in a new-session prompt, newest or active first. */
export const TODO_START_RELATED_LIMIT = 5;

export const todoBucketSchema = z.enum(["inbox", "focus", "later", "waiting"]);
export type TodoBucket = z.infer<typeof todoBucketSchema>;

export const todoFormalBucketSchema = z.enum(TODO_FORMAL_BUCKETS);
export type TodoFormalBucket = z.infer<typeof todoFormalBucketSchema>;

const TODO_ID_PATTERN = /^(?:[tT]-)?([1-9]\d*)$/u;

export function formatTodoId(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new RangeError(`Todo sequence must be a positive safe integer: ${seq}`);
  }
  return `T-${seq}`;
}

/**
 * Accepts `T-1`, `t-1`, and `1`; anything else (including `T-01` and `T-0`)
 * returns null. The caller decides whether that is a CLI error or a miss.
 */
export function parseTodoId(input: string | number): number | null {
  if (typeof input === "number") {
    return Number.isSafeInteger(input) && input > 0 ? input : null;
  }
  const match = TODO_ID_PATTERN.exec(input.trim());
  if (match === null) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}

export function normalizeTodoId(input: string | number): string | null {
  const seq = parseTodoId(input);
  return seq === null ? null : formatTodoId(seq);
}

export const todoIdSchema = z
  .string()
  .trim()
  .regex(TODO_ID_PATTERN, "Use a todo id like T-1, t-1, or 1");

export const todoThreadLinkSchema = z.object({
  threadId: z.string(),
  note: z.string(),
  linkedAt: z.string(),
  threadTitle: z.string().nullable().optional(),
  threadStatus: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  environmentId: z.string().nullable().optional(),
});
export type TodoThreadLink = z.infer<typeof todoThreadLinkSchema>;

export const todoLogEntrySchema = z.object({
  id: z.number().int().positive(),
  text: z.string(),
  threadId: z.string().nullable(),
  createdAt: z.string(),
});
export type TodoLogEntry = z.infer<typeof todoLogEntrySchema>;

export const todoItemSchema = z.object({
  id: z.string(),
  seq: z.number().int().positive(),
  title: z.string(),
  bucket: todoBucketSchema,
  notes: z.string(),
  proposalReason: z.string().nullable(),
  listName: z.string(),
  sectionName: z.string(),
  completedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  threads: z.array(todoThreadLinkSchema),
  logs: z.array(todoLogEntrySchema),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

export const todoColorSchema = z.enum(TODO_COLORS);

export const todoListSummarySchema = z.object({
  name: z.string(),
  color: todoColorSchema,
  openCount: z.number().int().nonnegative(),
  sections: z.array(z.string()),
});
export type TodoListSummary = z.infer<typeof todoListSummarySchema>;

export const todoCountsSchema = z.object({
  inbox: z.number().int().nonnegative(),
  focus: z.number().int().nonnegative(),
  later: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
});
export type TodoCounts = z.infer<typeof todoCountsSchema>;

export const todoSnapshotSchema = z.object({
  buckets: z.object({
    focus: z.array(todoItemSchema),
    later: z.array(todoItemSchema),
    waiting: z.array(todoItemSchema),
    inbox: z.array(todoItemSchema),
  }),
  done: z.array(todoItemSchema),
  counts: todoCountsSchema,
  lists: z.array(todoListSummarySchema),
});
export type TodoSnapshot = z.infer<typeof todoSnapshotSchema>;

export const todoListStatusSchema = z.enum(["open", "inbox", "done", "all"]);
export type TodoListStatus = z.infer<typeof todoListStatusSchema>;

export const triageActionSchema = z.enum(["accept", "merge", "dismiss"]);
export type TriageAction = z.infer<typeof triageActionSchema>;

export const todoScanItemSchema = z.object({
  id: z.string(),
  seq: z.number().int().positive(),
  title: z.string(),
  bucket: todoFormalBucketSchema,
  listName: z.string(),
  sectionName: z.string(),
  latestLog: todoLogEntrySchema.nullable(),
  threads: z.array(todoThreadLinkSchema),
  hasRunningThread: z.boolean(),
  actionable: z.boolean(),
  updatedAt: z.string(),
});
export type TodoScanItem = z.infer<typeof todoScanItemSchema>;

export const todoScanResultSchema = z.object({
  inboxCount: z.number().int().nonnegative(),
  items: z.array(todoScanItemSchema),
});
export type TodoScanResult = z.infer<typeof todoScanResultSchema>;

const todoListNameSchema = z.string().trim().max(TODO_LIST_NAME_MAX_LENGTH);
const todoSectionNameSchema = z.string().trim().max(TODO_SECTION_NAME_MAX_LENGTH);

export const quickAddInput = z.object({
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH),
  bucket: todoFormalBucketSchema.default("focus"),
  listName: todoListNameSchema.optional(),
  sectionName: todoSectionNameSchema.optional(),
});

export const updateTodoInput = z.object({
  id: todoIdSchema,
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH).optional(),
  bucket: todoFormalBucketSchema.optional(),
  notes: z.string().max(TODO_NOTES_MAX_LENGTH).optional(),
  listName: todoListNameSchema.optional(),
  sectionName: todoSectionNameSchema.optional(),
  sortOrder: z.number().optional(),
});

export const setTodoCompletedInput = z.object({
  id: todoIdSchema,
  completed: z.boolean(),
  note: z.string().trim().max(TODO_LOG_TEXT_MAX_LENGTH).optional(),
});

export const triageInboxInput = z
  .object({
    id: todoIdSchema,
    action: triageActionSchema,
    bucket: todoFormalBucketSchema.optional(),
    intoId: todoIdSchema.optional(),
    listName: todoListNameSchema.optional(),
    sectionName: todoSectionNameSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.action === "merge" && value.intoId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Merging requires intoId",
        path: ["intoId"],
      });
    }
    if (value.action !== "merge" && value.intoId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "intoId is only valid when action is merge",
        path: ["intoId"],
      });
    }
    if (value.action !== "accept" && value.bucket !== undefined) {
      context.addIssue({
        code: "custom",
        message: "bucket is only valid when action is accept",
        path: ["bucket"],
      });
    }
    if (value.action !== "accept" && (value.listName !== undefined || value.sectionName !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "listName and sectionName are only valid when action is accept",
        path: ["listName"],
      });
    }
  });

export const addTodoLogInput = z.object({
  id: todoIdSchema,
  text: z.string().trim().min(1).max(TODO_LOG_TEXT_MAX_LENGTH),
  threadId: z.string().trim().min(1).optional(),
});

export const linkTodoThreadInput = z.object({
  id: todoIdSchema,
  threadId: z.string().trim().min(1),
  note: z.string().trim().max(TODO_THREAD_NOTE_MAX_LENGTH).optional(),
});

export const unlinkTodoThreadInput = z.object({
  id: todoIdSchema,
  threadId: z.string().trim().min(1),
});

export const removeTodoInput = z.object({ id: todoIdSchema });

export const setListColorInput = z.object({
  listName: z.string().trim().min(1).max(TODO_LIST_NAME_MAX_LENGTH),
  color: todoColorSchema,
});

export const listRevisionsInput = z.object({
  limit: z.number().int().min(1).max(TODO_REVISION_LIMIT_MAX).default(TODO_REVISION_LIMIT_DEFAULT),
});

export const TODO_REVISION_ACTIONS = [
  "create",
  "update",
  "complete",
  "reopen",
  "triage_accept",
  "triage_merge",
  "triage_dismiss",
  "delete",
  "undo",
] as const;
export const todoRevisionActionSchema = z.enum(TODO_REVISION_ACTIONS);
export type TodoRevisionAction = z.infer<typeof todoRevisionActionSchema>;

export const todoRevisionSchema = z.object({
  rev: z.number().int().positive(),
  itemSeq: z.number().int().positive(),
  itemId: z.string(),
  action: todoRevisionActionSchema,
  actor: z.string(),
  summary: z.string(),
  undoneAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TodoRevision = z.infer<typeof todoRevisionSchema>;

export const undoRevisionInput = z.object({
  rev: z.number().int().positive().optional(),
});

export const undoRevisionOutput = z.object({
  undoneRev: z.number().int().positive(),
  revision: todoRevisionSchema,
});

export const prepareStartSessionInput = z.object({
  id: todoIdSchema,
});

export const prepareStartSessionOutput = z.object({
  itemId: z.string(),
  title: z.string(),
  projectId: z.string().nullable(),
  environmentId: z.string().nullable(),
  initialPrompt: z.string(),
  relatedThreadCount: z.number().int().nonnegative(),
});
export type PrepareStartSessionResult = z.infer<typeof prepareStartSessionOutput>;

const triageInboxOutput = z.object({
  action: triageActionSchema,
  item: todoItemSchema.nullable(),
});

/**
 * The single authority for panel RPC names, inputs, and outputs. The phase 2
 * app calls these methods through `useRpc<typeof rpcContract>()`; the CLI in
 * this phase calls the same service functions directly.
 */
export const rpcContract = defineRpcContract({
  listSnapshot: {
    input: z.object({}),
    output: todoSnapshotSchema,
  },
  quickAdd: {
    input: quickAddInput,
    output: todoItemSchema,
  },
  update: {
    input: updateTodoInput,
    output: todoItemSchema,
  },
  setCompleted: {
    input: setTodoCompletedInput,
    output: todoItemSchema,
  },
  triageInbox: {
    input: triageInboxInput,
    output: triageInboxOutput,
  },
  addLog: {
    input: addTodoLogInput,
    output: todoItemSchema,
  },
  linkThread: {
    input: linkTodoThreadInput,
    output: todoItemSchema,
  },
  unlinkThread: {
    input: unlinkTodoThreadInput,
    output: todoItemSchema,
  },
  remove: {
    input: removeTodoInput,
    output: z.object({ removed: z.boolean() }),
  },
  prepareStartSession: {
    input: prepareStartSessionInput,
    output: prepareStartSessionOutput,
  },
  setListColor: {
    input: setListColorInput,
    output: todoListSummarySchema,
  },
  listRevisions: {
    input: listRevisionsInput,
    output: z.object({ revisions: z.array(todoRevisionSchema) }),
  },
  undoRevision: {
    input: undoRevisionInput,
    output: undoRevisionOutput,
  },
});

const HAN_PATTERN = /\p{Script=Han}/u;

function isListToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= TODO_LIST_NAME_MAX_LENGTH &&
    !/[\s/]/u.test(value)
  );
}

/**
 * `#List title` or `#List/Section title` at the start of a quick-add title.
 * A spaced section is kept intact when the title begins at the first Han
 * character (`#LightSpace/Hosting Station 写 demo 期方案`). Otherwise the
 * section is the first token. Returns null when the remainder would be empty.
 */
export function parseTitlePrefix(
  raw: string,
): { listName: string; sectionName: string; title: string } | null {
  const input = raw.trim();
  if (!input.startsWith("#")) return null;
  const body = input.slice(1);
  const slash = body.indexOf("/");
  const firstWs = body.search(/\s/u);
  if (firstWs <= 0) return null;

  if (slash === -1 || slash > firstWs) {
    const listName = body.slice(0, firstWs);
    const title = body.slice(firstWs).trim();
    if (!isListToken(listName) || title.length === 0 || title.length > TODO_TITLE_MAX_LENGTH) {
      return null;
    }
    return { listName, sectionName: "", title };
  }

  const listName = body.slice(0, slash);
  if (!isListToken(listName)) return null;
  const after = body.slice(slash + 1).trim();
  const han = after.search(HAN_PATTERN);
  if (han > 0 && /\s/u.test(after.slice(0, han))) {
    const sectionName = after.slice(0, han).trim();
    const title = after.slice(han).trim();
    if (
      sectionName.length > 0 &&
      sectionName.length <= TODO_SECTION_NAME_MAX_LENGTH &&
      !sectionName.includes("/") &&
      title.length > 0 &&
      title.length <= TODO_TITLE_MAX_LENGTH
    ) {
      return { listName, sectionName, title };
    }
  }
  const match = /^(\S+)\s+(\S[\s\S]*)$/u.exec(after);
  if (!match) return null;
  const sectionName = match[1] ?? "";
  const title = (match[2] ?? "").trim();
  if (
    sectionName.length === 0 ||
    sectionName.length > TODO_SECTION_NAME_MAX_LENGTH ||
    title.length === 0 ||
    title.length > TODO_TITLE_MAX_LENGTH
  ) {
    return null;
  }
  return { listName, sectionName, title };
}

/** Used once every palette color is already taken by some list. */
export function fallbackTodoColor(listName: string): TodoColor {
  let hash = 2166136261;
  for (const char of listName) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return TODO_COLORS[(hash >>> 0) % TODO_COLORS.length] ?? "blue";
}

/**
 * An explicit list or section wins over the `#List/Section` prefix. Omitted
 * fields fall back to the prefix, then to empty (uncategorized / no section).
 */
export function resolveTodoPlacement(
  title: string,
  explicit: { listName?: string; sectionName?: string },
): { title: string; listName: string; sectionName: string } {
  const parsed = parseTitlePrefix(title);
  const cleanTitle = (parsed?.title ?? title).trim();
  return {
    title: cleanTitle,
    listName: (explicit.listName !== undefined ? explicit.listName : (parsed?.listName ?? "")).trim(),
    sectionName: (
      explicit.sectionName !== undefined ? explicit.sectionName : (parsed?.sectionName ?? "")
    ).trim(),
  };
}

export type TodoRpcContract = typeof rpcContract;
