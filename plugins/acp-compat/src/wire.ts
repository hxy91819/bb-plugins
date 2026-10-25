import { z } from "zod";

export const messageSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type Message = z.infer<typeof messageSchema>;
export type Id = string | number;
export const recordSchema = z.record(z.string(), z.unknown());
export function record(value: unknown): Record<string, unknown> {
  return recordSchema.safeParse(value).data ?? {};
}
