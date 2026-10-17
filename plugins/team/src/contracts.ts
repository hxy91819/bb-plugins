import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { ExperimentalThreadActivityResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { memberId } from "./member-id.js";
export { memberId } from "./member-id.js";
export const profileInput = z
  .object({
    displayName: z
      .string()
      .trim()
      .refine(
        (s) => Array.from(s).length >= 1 && Array.from(s).length <= 80,
        "Name must contain 1–80 characters",
      ),
    avatarId: z.string().max(40).default("cat"),
  })
  .strict();
export const initializeInput = z.object({}).strict();
export const memberSchema = z.object({
  memberId,
  displayName: z.string(),
  avatarId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Member = z.infer<typeof memberSchema>;
export const pageInput = z
  .object({
    search: z.string().trim().max(80).default(""),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: memberId.nullable().default(null),
  })
  .strict();
export const pageSchema = z.object({
  members: z.array(memberSchema),
  nextCursor: memberId.nullable(),
});
export const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return !/^[+-]/.test(value);
    } catch {
      return false;
    }
  }, "Use an IANA timezone (for example UTC or Asia/Shanghai)");
export const creationInput = z
  .object({ memberId: memberId.nullable() })
  .strict();
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const activityInput = z
  .object({
    mode: z.enum(["summary", "details"]).default("summary"),
    memberId: memberId.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    date: z.union([calendarDate, z.literal("today")]).optional(),
    fromDate: calendarDate.optional(),
    toDate: calendarDate.optional(),
    projectId: z.string().min(1).max(128).optional(),
    threadId: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    maxChars: z.number().int().min(2048).max(24000).default(8000),
    cursor: z.string().min(1).max(8192).optional(),
  })
  .strict();
export const activityQuerySchema = z
  .object({
    mode: z.enum(["summary", "details"]),
    memberId,
    timezone: timezoneSchema,
    fromDate: calendarDate,
    toDate: calendarDate,
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    projectId: z.string().min(1).max(128).optional(),
    threadId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ActivityInput = z.input<typeof activityInput>;
export type ActivityQuery = z.infer<typeof activityQuerySchema>;
export type ActivityResponse = ExperimentalThreadActivityResult & {
  query: ActivityQuery;
};
const evidenceType = z.enum([
  "acceptedInput",
  "agentMessage",
  "commandExecution",
  "completedTurn",
  "fileChange",
  "toolCall",
]);
const evidenceStatus = z.enum([
  "accepted",
  "completed",
  "failed",
  "interrupted",
  "pending",
  "statement",
  "unknown",
]);
const evidence = z.object({
  commandName: z.string().nullable(),
  createdAt: z.number(),
  eventId: z.string(),
  excerpt: z.string(),
  excerptTruncated: z.boolean(),
  exitCode: z.number().nullable(),
  filePath: z.string().nullable(),
  outcome: z.enum(["exit-nonzero", "exit-zero", "unknown"]),
  sequence: z.number(),
  status: evidenceStatus,
  threadId: z.string(),
  type: evidenceType,
});
const activityEnvelope = z.object({
  query: activityQuerySchema,
  budget: z.object({
    encoding: z.literal("compact-json-utf8"),
    maxBytes: z.literal(262144),
  }),
  coverage: z.object({
    asOf: z.number(),
    forkBoundaryGaps: z.object({
      count: z.number(),
      missingIdentityCount: z.number(),
      uncertainPrefixCount: z.number(),
      samples: z.array(
        z.object({
          projectId: z.string(),
          reason: z.enum(["missing-local-identity", "prefix-sequence-gap"]),
          threadId: z.string(),
        }),
      ),
    }),
    from: z.number(),
    to: z.number(),
    includesArchived: z.literal(true),
    includesHidden: z.literal(true),
    incomplete: z.boolean(),
    limitations: z.array(z.string()),
    pagination: z.literal("live-pagination"),
    source: z.literal("retained-events"),
    throughSequence: z.number().nullable(),
  }),
  hasMore: z.boolean(),
  truncated: z.boolean(),
  returned: z.number(),
  nextCursor: z.string().nullable(),
});
export const activityOutput = z.discriminatedUnion("mode", [
  activityEnvelope.extend({
    mode: z.literal("summary"),
    totalThreads: z.number(),
    items: z.array(
      z.object({
        acceptedInputs: z.number(),
        completedTurns: z.number(),
        counts: z.array(
          z.object({
            count: z.number(),
            status: evidenceStatus,
            type: evidenceType,
          }),
        ),
        cursorAfter: z.string(),
        lastActivityAt: z.number(),
        projectId: z.string(),
        recentEvidence: z.array(evidence),
        threadId: z.string(),
        title: z.string(),
      }),
    ),
  }),
  activityEnvelope.extend({
    mode: z.literal("details"),
    totalEvidence: z.number(),
    items: z.array(evidence.extend({ cursorAfter: z.string() })),
  }),
]) satisfies z.ZodType<ActivityResponse>;
export const rpcContract = defineRpcContract({
  initialize: {
    input: initializeInput,
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("initialized"), member: memberSchema }),
      z.object({
        status: z.literal("already_initialized"),
        adminMemberId: memberId,
      }),
    ]),
  },
  state: {
    input: z.null(),
    output: z.object({
      serverScope: z.string().uuid(),
      adminMemberId: memberId.nullable(),
      timezone: timezoneSchema,
      timezoneConfigured: z.boolean(),
      threadIntegration: z.boolean(),
    }),
  },
  members_list: { input: pageInput, output: pageSchema },
  members_resolve: {
    input: z
      .object({
        name: z.string().trim().min(1).max(80),
        limit: z.number().int().min(1).max(100).default(10),
        cursor: memberId.nullable().default(null),
      })
      .strict(),
    output: z.object({
      status: z.enum(["not_found", "unique", "ambiguous"]),
      members: z.array(memberSchema),
      nextCursor: memberId.nullable(),
    }),
  },
  members_get: {
    input: z.object({ memberId }).strict(),
    output: memberSchema.nullable(),
  },
  members_batch: {
    input: z.object({ memberIds: z.array(memberId).max(200) }).strict(),
    output: z.array(memberSchema),
  },
  activity: { input: activityInput, output: activityOutput },
  members_create: {
    input: profileInput.extend({ actorMemberId: memberId }).strict(),
    output: memberSchema,
  },
  members_updateSelf: {
    input: profileInput.extend({ memberId }).strict(),
    output: memberSchema,
  },
  identity_validate: {
    input: z.object({ memberId: memberId.nullable() }).strict(),
    output: z.object({ valid: z.boolean(), member: memberSchema.nullable() }),
  },
  avatars_list: {
    input: z.null(),
    output: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        file: z.string(),
        alt: z.string(),
        url: z.string(),
      }),
    ),
  },
  timezone_set: {
    input: z.object({ timezone: timezoneSchema }).strict(),
    output: z.object({ timezone: timezoneSchema }),
  },
});
export type TeamContract = typeof rpcContract;

export type Avatar = z.infer<typeof rpcContract.avatars_list.output>[number];
