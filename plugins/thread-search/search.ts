import { z } from "zod";

export const pageSize = 25;
export const searchResponse = z.object({
  total: z.number().int().nonnegative(),
  matches: z.array(
    z.object({
      sourceKind: z.enum(["user_message", "assistant_message"]),
      sourceSeq: z.number().int().nonnegative(),
      text: z.string(),
      highlightRanges: z.array(
        z.object({
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
});
export type SearchResult = z.infer<typeof searchResponse>;
export interface SearchInput {
  threadId: string;
  query: string;
  limit: number;
  offset: number;
  signal: AbortSignal;
}
export async function searchMessages(
  threads: object,
  input: SearchInput,
): Promise<SearchResult> {
  const method: unknown = Reflect.get(threads, "experimental_searchMessages");
  if (typeof method !== "function") {
    throw new Error(
      "Conversation search requires a BB build with threads.experimental_searchMessages support.",
    );
  }
  const response: unknown = await Reflect.apply(method, threads, [input]);
  return searchResponse.parse(response);
}
