import type {
  BbPluginApi,
  ExperimentalThreadActivityResult,
} from "@get-bb/plugin-sdk";
import { CronDate } from "cron-parser";
import { z } from "zod";
import {
  activityInput,
  activityOutput,
  activityQuerySchema,
  memberId,
  timezoneSchema,
} from "./contracts.js";
import type { ActivityQuery, ActivityResponse } from "./contracts.js";
import type { createMemberService } from "./members.js";

const cursorSchema = z
  .object({
    version: z.literal(1),
    query: activityQuerySchema,
    core: z.string().min(1).max(2048),
    date: z.string().optional(),
  })
  .strict();
function day(value: string, timezone: string) {
  const result = new CronDate(`${value}T00:00:00`, timezone);
  const actual = `${result.getFullYear().toString().padStart(4, "0")}-${(result.getMonth() + 1).toString().padStart(2, "0")}-${result.getDate().toString().padStart(2, "0")}`;
  if (actual !== value) throw Error("invalid_calendar_date");
  return result;
}
function today(timezone: string) {
  const now = new CronDate(Date.now(), timezone);
  return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
}
export function createActivityService(
  sdk: Pick<BbPluginApi["sdk"], "threads">,
  members: ReturnType<typeof createMemberService>,
  getTimezone: () => Promise<{ timezone: string }>,
) {
  return async (raw: unknown): Promise<ActivityResponse> => {
    const input = activityInput.parse(raw);
    let saved: z.infer<typeof cursorSchema> | undefined;
    if (input.cursor) {
      try {
        saved = cursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        );
      } catch {
        throw Error("invalid_activity_cursor");
      }
    }
    if (input.memberId && input.name) throw Error("choose_member_id_or_name");
    let id = input.memberId ?? saved?.query.memberId;
    if (input.name) {
      const resolution = members.resolve({
        name: input.name,
        limit: 10,
        cursor: null,
      });
      if (resolution.status !== "unique")
        throw Error(
          JSON.stringify({
            error: `member_${resolution.status}`,
            candidates: resolution.members,
            nextCursor: resolution.nextCursor,
          }),
        );
      id = resolution.members[0]!.memberId;
    }
    if (!id || !members.get(id))
      throw Error("member_not_found: specify --member ID or --name NAME");
    const mode = input.mode;
    if (input.date && (input.fromDate || input.toDate))
      throw Error("choose_date_or_range");
    if (!saved && Boolean(input.fromDate) !== Boolean(input.toDate))
      throw Error("both_from_date_and_to_date_required");
    let query: ActivityQuery;
    if (saved) {
      query = saved.query;
      if (
        id !== query.memberId ||
        mode !== query.mode ||
        (input.projectId !== undefined &&
          input.projectId !== query.projectId) ||
        (input.threadId !== undefined && input.threadId !== query.threadId) ||
        (input.date !== undefined &&
          input.date !== saved.date &&
          input.date !== query.fromDate) ||
        (input.fromDate !== undefined && input.fromDate !== query.fromDate) ||
        (input.toDate !== undefined && input.toDate !== query.toDate)
      )
        throw Error("cursor_query_mismatch");
    } else {
      const timezone = timezoneSchema.parse((await getTimezone()).timezone);
      const date = input.date ?? (input.fromDate ? undefined : "today");
      const fromDate =
        date === "today" ? today(timezone) : (date ?? input.fromDate);
      if (!fromDate) throw Error("from_date_required");
      const start = day(fromDate, timezone);
      const end = new CronDate(start);
      end.addDay();
      const toDate =
        input.toDate ??
        `${end.getFullYear()}-${(end.getMonth() + 1).toString().padStart(2, "0")}-${end.getDate().toString().padStart(2, "0")}`;
      const to = day(toDate, timezone).getTime();
      query = activityQuerySchema.parse({
        mode,
        memberId: id,
        timezone,
        fromDate,
        toDate,
        from: start.getTime(),
        to,
        ...(input.projectId === undefined
          ? {}
          : { projectId: input.projectId }),
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      });
    }
    memberId.parse(query.memberId);
    if (query.from >= query.to)
      throw Error("invalid_date_range: --to-date is exclusive");
    if (query.mode === "details" && !query.threadId)
      throw Error("details_thread_required");
    if (query.mode === "summary" && query.threadId)
      throw Error("thread_requires_details");
    const date =
      saved?.date ?? input.date ?? (input.fromDate ? undefined : "today");
    const wrap = (core: string) =>
      Buffer.from(JSON.stringify({ version: 1, query, core, date })).toString(
        "base64url",
      );
    const common = {
      metadata: { key: "memberId", equals: query.memberId },
      from: query.from,
      to: query.to,
      projectId: query.projectId,
      limit: input.limit,
      cursor: saved?.core,
    };
    const page = await sdk.threads.experimental_activity(
      query.mode === "details"
        ? { ...common, mode: "details", threadId: query.threadId! }
        : { ...common, mode: "summary" },
    );
    const emitted: ExperimentalThreadActivityResult["items"][number][] = [];
    let shortened = false;
    const envelope = (): ActivityResponse => {
      const hasMore = emitted.length < page.items.length || page.hasMore;
      return activityOutput.parse({
        ...page,
        query,
        items: emitted,
        returned: emitted.length,
        hasMore,
        truncated:
          page.truncated || shortened || emitted.length < page.items.length,
        nextCursor: hasMore
          ? (emitted.at(-1)?.cursorAfter ?? input.cursor ?? null)
          : null,
      });
    };
    const length = () => Array.from(JSON.stringify(envelope())).length;
    for (const source of page.items) {
      const item = { ...source, cursorAfter: wrap(source.cursorAfter) };
      emitted.push(item);
      if (length() > input.maxChars) {
        if (emitted.length > 1) {
          emitted.pop();
          break;
        }
        if ("excerpt" in item) {
          item.excerpt = "";
          item.excerptTruncated = true;
        } else {
          item.recentEvidence = item.recentEvidence.map((evidence) => ({
            ...evidence,
            excerpt: "",
            excerptTruncated: true,
          }));
          item.title = Array.from(item.title).slice(0, 40).join("");
        }
        shortened = true;
        if (length() > input.maxChars)
          throw Error(
            `activity_budget_too_small: require at least ${length()} characters`,
          );
        break;
      }
    }
    if (length() > input.maxChars)
      throw Error(
        `activity_budget_too_small: require at least ${length()} characters`,
      );
    return envelope();
  };
}
