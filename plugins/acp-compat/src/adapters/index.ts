import { z } from "zod";
import { codebuddyAdapter } from "./codebuddy.js";
import type { AcpAdapter } from "./types.js";
export const adapterIdSchema = z.enum(["passthrough", "codebuddy"]);
export type AdapterId = z.infer<typeof adapterIdSchema>;
const adapters: Record<AdapterId, AcpAdapter> = {
  passthrough: { serialize: false },
  codebuddy: codebuddyAdapter,
};
export function adapterFor(id: AdapterId): AcpAdapter {
  return adapters[id];
}
