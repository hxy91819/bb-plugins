import { useEffect, useState } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import {
  ThreadChat,
  useSdk,
  type PluginBrowserBbSdk,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";

type SideChat = Pick<
  Awaited<ReturnType<PluginBrowserBbSdk["threads"]["list"]>>[number],
  | "id"
  | "sourceThreadId"
  | "title"
  | "titleFallback"
  | "lastReadAt"
  | "latestAttentionAt"
>;

export const sideChatsAtom = atom<readonly SideChat[]>([]);

let latestRefresh = 0;

export function isSideChatUnread(
  chat: Pick<SideChat, "lastReadAt" | "latestAttentionAt">,
): boolean {
  return (chat.lastReadAt ?? 0) < chat.latestAttentionAt;
}

export function useSideChatsSync(): void {
  const sdk = useSdk();
  const setChats = useSetAtom(sideChatsAtom);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      const revision = ++latestRefresh;
      try {
        const chats: SideChat[] = [];
        for (let offset = 0; ; offset += 100) {
          const page = await sdk.threads.list({
            archived: false,
            includeHidden: true,
            originKind: "fork",
            originPluginId: "side-chat",
            limit: 100,
            offset,
            signal: controller.signal,
          });
          chats.push(
            ...page.filter(
              (chat) =>
                chat.visibility === "hidden" &&
                chat.sourceThreadId !== null &&
                chat.archivedAt === null &&
                chat.deletedAt === null,
            ),
          );
          if (page.length < 100) break;
        }
        if (!controller.signal.aborted && revision === latestRefresh)
          setChats(chats);
      } catch (error) {
        if (!controller.signal.aborted)
          console.warn("Loading side chats failed", error);
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [sdk, setChats]);
}

export function SideChatsSync() {
  useSideChatsSync();
  return null;
}

export function useUnreadSideChats(
  threadId: string,
  collapsedThreadIds: readonly string[],
): boolean {
  const chats = useAtomValue(sideChatsAtom);
  return chats.some(
    (chat) =>
      chat.sourceThreadId !== null &&
      (chat.sourceThreadId === threadId ||
        collapsedThreadIds.includes(chat.sourceThreadId)) &&
      isSideChatUnread(chat),
  );
}

export function SideChatsPanel({ threadId }: PluginThreadPanelProps) {
  useSideChatsSync();
  const chats = useAtomValue(sideChatsAtom).filter(
    (chat) => chat.sourceThreadId === threadId,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = chats.find((chat) => chat.id === selectedId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-1 overflow-auto border-b p-2 max-h-40">
        {chats.length === 0 && (
          <span className="text-sm text-muted-foreground">暂无 side chat</span>
        )}
        {chats.map((chat) => (
          <button
            key={chat.id}
            type="button"
            aria-pressed={chat.id === selectedId}
            onClick={() => setSelectedId(chat.id)}
            className="flex items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-surface-hover aria-pressed:bg-surface-hover"
          >
            {isSideChatUnread(chat) && (
              <span
                role="img"
                aria-label="Unread side chat"
                className="size-1.5 shrink-0 rounded-full bg-current"
              />
            )}
            <span className="truncate">
              {chat.title ?? chat.titleFallback ?? "Side chat"}
            </span>
          </button>
        ))}
      </div>
      {selected && (
        <ThreadChat
          key={selected.id}
          threadId={selected.id}
          variant="compact"
          layout="contained"
          permissionPolicy="editable"
          className="min-h-0 flex-1"
        />
      )}
    </div>
  );
}
