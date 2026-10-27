import { useEffect, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { SidebarThread } from "./sidebar-thread.js";

export function useUnreadTurnCount(thread: SidebarThread): number | null {
  const sdk = useSdk();
  const { id, isUnread, lastReadAt, latestAttentionAt, parentThreadId } =
    thread;
  const [result, setResult] = useState<{
    id: string;
    lastReadAt: number | null;
    count: number;
  } | null>(null);

  useEffect(() => {
    if (!isUnread || parentThreadId !== null || lastReadAt === null) return;
    const readAt = lastReadAt;
    const controller = new AbortController();
    async function load() {
      let beforeSeq: string | undefined;
      let count = 0;
      while (!controller.signal.aborted) {
        const events = await sdk.threads.events.list({
          threadId: id,
          types: ["turn/completed"],
          order: "desc",
          limit: "100",
          beforeSeq,
          signal: controller.signal,
        });
        for (const event of events) {
          if (
            event.createdAt > readAt &&
            event.type === "turn/completed" &&
            event.data.status === "completed"
          ) {
            count += 1;
          }
        }
        const oldest = events.at(-1);
        if (events.length < 100 || !oldest || oldest.createdAt <= readAt) break;
        beforeSeq = String(oldest.seq);
      }
      if (!controller.signal.aborted) {
        setResult({ id, lastReadAt, count });
      }
    }
    void load().catch(() => {});
    return () => controller.abort();
  }, [sdk, id, isUnread, lastReadAt, latestAttentionAt, parentThreadId]);

  if (isUnread && parentThreadId === null && lastReadAt === null) return null;

  return isUnread && result?.id === id && result.lastReadAt === lastReadAt
    ? result.count
    : 0;
}
