// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultStore } from "jotai";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";

installTestPluginRuntime();
const { SideChatsSync, SideChatsPanel, sideChatsAtom } =
  await import("./side-chats.js");

function listedChat(overrides: Parameters<typeof makeThreadResponse>[0]) {
  return {
    ...makeThreadResponse(overrides),
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    environmentBranchName: null,
    environmentHostId: null,
    environmentIsWorktree: null,
    environmentName: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentWorkspaceDisplayKind: "other" as const,
    hasPendingInteraction: false,
    pinSortKey: null,
    queuedWork: "none" as const,
    runtime: { displayStatus: "idle" as const },
  };
}

afterEach(() => {
  cleanup();
  getDefaultStore().set(sideChatsAtom, []);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("side-chat unread", () => {
  it.each([false, true])(
    "does not restore unread from an older sidebar request after a newer panel refresh (newer request fails: %s)",
    async (failed) => {
      const unread = listedChat({
        id: "side",
        visibility: "hidden",
        sourceThreadId: "owner",
        title: "Reply",
        lastReadAt: 100,
        latestAttentionAt: 200,
      });
      const read = { ...unread, lastReadAt: 200 };
      getDefaultStore().set(sideChatsAtom, [failed ? read : unread]);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let finishOld!: (rows: ReturnType<typeof listedChat>[]) => void;
      const oldResponse = new Promise<ReturnType<typeof listedChat>[]>(
        (resolve) => {
          finishOld = resolve;
        },
      );
      renderSlot(
        { component: SideChatsSync },
        {},
        { sdk: { threads: { list: () => oldResponse } } },
      );
      renderSlot(
        { component: SideChatsPanel },
        { threadId: "owner", params: null },
        {
          sdk: {
            threads: {
              list: async () => {
                if (failed) throw new Error("offline");
                return [read];
              },
            },
          },
        },
      );
      await waitFor(() => {
        if (failed) expect(console.warn).toHaveBeenCalled();
        expect(
          screen.queryByRole("img", { name: "Unread side chat" }),
        ).toBeNull();
      });
      await act(async () => finishOld([unread]));
      expect(
        screen.queryByRole("img", { name: "Unread side chat" }),
      ).toBeNull();
      expect(getDefaultStore().get(sideChatsAtom)[0]?.lastReadAt).toBe(200);
    },
  );
  it("loads later pages, excludes non-side-chat visibility and reconciles reads without writing read state", async () => {
    const chat = listedChat({
      id: "side",
      visibility: "hidden",
      sourceThreadId: "owner",
      lastReadAt: null,
      latestAttentionAt: 200,
    });
    let read = false;
    const list = vi.fn(async ({ offset }: { offset?: number } = {}) =>
      offset === 0
        ? Array.from({ length: 100 }, (_, index) =>
            listedChat({ id: `visible-${index}`, visibility: "visible" }),
          )
        : [{ ...chat, lastReadAt: read ? 200 : null }],
    );
    const slot = renderSlot(
      { component: SideChatsSync },
      {},
      { sdk: { threads: { list } } },
    );
    await waitFor(() =>
      expect(
        getDefaultStore()
          .get(sideChatsAtom)
          .map((chat) => chat.id),
      ).toEqual(["side"]),
    );
    read = true;
    fireEvent.focus(window);
    await waitFor(() =>
      expect(getDefaultStore().get(sideChatsAtom)[0]?.lastReadAt).toBe(200),
    );
    expect(
      slot.inspection.sdkCalls.every((call) => call.method === "threads.list"),
    ).toBe(true);
    expect(list.mock.calls[0]?.[0]).toMatchObject({
      includeHidden: true,
      originPluginId: "side-chat",
      originKind: "fork",
      archived: false,
      limit: 100,
    });
    slot.lifecycle.unmount();
    const calls = list.mock.calls.length;
    fireEvent.focus(window);
    expect(list).toHaveBeenCalledTimes(calls);
  });

  it("retains unread on a failed refresh and aborts in-flight work when disposed", async () => {
    const chat = listedChat({
      id: "side",
      visibility: "hidden",
      sourceThreadId: "owner",
      lastReadAt: 100,
      latestAttentionAt: 200,
    });
    getDefaultStore().set(sideChatsAtom, [chat]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = vi.fn().mockRejectedValueOnce(new Error("offline"));
    const slot = renderSlot(
      { component: SideChatsSync },
      {},
      { sdk: { threads: { list } } },
    );
    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(getDefaultStore().get(sideChatsAtom)).toEqual([chat]);
    slot.lifecycle.unmount();
    expect(list.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it("lists only the owner's side chats and opens a chat only after choosing it", async () => {
    const chat = listedChat({
      id: "side",
      visibility: "hidden",
      sourceThreadId: "child-owner",
      title: "Unread reply",
      lastReadAt: 100,
      latestAttentionAt: 200,
    });
    const other = {
      ...chat,
      id: "other",
      sourceThreadId: "other-owner",
      title: "Other owner",
    };
    const slot = renderSlot(
      { component: SideChatsPanel },
      { threadId: "child-owner", params: null },
      { sdk: { threads: { list: async () => [chat, other] } } },
    );
    await screen.findByRole("button", { name: /Unread reply/ });
    expect(screen.queryByText("Other owner")).toBeNull();
    expect(
      screen.getAllByRole("img", { name: "Unread side chat" }),
    ).toHaveLength(1);
    expect(screen.queryByTestId("bb-thread-chat")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Unread reply/ }));
    expect(
      screen.getByTestId("bb-thread-chat").getAttribute("data-thread-id"),
    ).toBe("side");
    act(() =>
      getDefaultStore().set(sideChatsAtom, [{ ...chat, lastReadAt: 200 }]),
    );
    expect(screen.queryByRole("img", { name: "Unread side chat" })).toBeNull();
    expect(
      slot.inspection.sdkCalls.every((call) => call.method === "threads.list"),
    ).toBe(true);
  });
});
