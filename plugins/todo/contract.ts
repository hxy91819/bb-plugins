import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Ephemeral realtime channel; every successful write publishes on it. */
export const TODO_CHANGED_EVENT = "todo:changed" as const;

export const TODO_FORMAL_BUCKETS = ["focus", "later", "waiting"] as const;
export const TODO_BUCKET_ORDER = ["focus", "later", "waiting", "inbox"] as const;

export const TODO_TITLE_MAX_LENGTH = 500;
export const TODO_NOTES_MAX_LENGTH = 20_000;
export const TODO_NEXT_STEP_MAX_LENGTH = 2_000;
export const TODO_LOG_TEXT_MAX_LENGTH = 4_000;
export const TODO_PROPOSAL_REASON_MAX_LENGTH = 2_000;
export const TODO_THREAD_NOTE_MAX_LENGTH = 1_000;
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
  nextStep: z.string(),
  proposalReason: z.string().nullable(),
  completedAt: z.string().nullable(),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  threads: z.array(todoThreadLinkSchema),
  logs: z.array(todoLogEntrySchema),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

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
  nextStep: z.string(),
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

export const quickAddInput = z.object({
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH),
  bucket: todoFormalBucketSchema.default("focus"),
});

export const updateTodoInput = z.object({
  id: todoIdSchema,
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH).optional(),
  bucket: todoFormalBucketSchema.optional(),
  notes: z.string().max(TODO_NOTES_MAX_LENGTH).optional(),
  nextStep: z.string().max(TODO_NEXT_STEP_MAX_LENGTH).optional(),
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
  });

export const addTodoLogInput = z.object({
  id: todoIdSchema,
  text: z.string().trim().min(1).max(TODO_LOG_TEXT_MAX_LENGTH),
  nextStep: z.string().max(TODO_NEXT_STEP_MAX_LENGTH).optional(),
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
});

export type TodoRpcContract = typeof rpcContract;
