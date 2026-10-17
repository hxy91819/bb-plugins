// @vitest-environment jsdom

import {
  installTestPluginRuntime,
  renderSlot,
  loadPluginApp,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { buildContributionGroupKey } from "../../shared/preferences.js";
import type { ReactNode } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import type { SidebarThread } from "../model/sidebar-thread.js";
import {
  makeSidebarEnvironment,
  makeSidebarThread,
  type SidebarThreadOverrides,
} from "../model/fixtures.js";
import {
  collapsedEnvironmentIdsAtom,
  collapsedSidebarSectionIdsAtom,
  collapsedThreadIdsAtom,
  sidebarCollapsedThreadSectionsAtom,
  sidebarOrganizationModeAtom,
  sidebarCollapsedMachinesAtom,
  sidebarCollapsedContributionGroupsAtom,
} from "../preferences/atoms.js";
import {
  useSidebarThreadRevealCore,
  type SidebarThreadRevealInputs,
} from "./useSidebarThreadReveal.js";

installTestPluginRuntime();
afterEach(cleanup);

function thread(id: string, overrides: SidebarThreadOverrides = {}) {
  return makeSidebarThread({
    id,
    projectId: "proj_personal",
    sectionId: id,
    lastReadAt: 1,
    latestAttentionAt: 1,
    ...overrides,
  });
}

function setup(
  threads: SidebarThread[],
  initial: Partial<SidebarThreadRevealInputs> = {},
  options: RenderSlotOptions = {},
) {
  const store = createStore();
  store.set(sidebarOrganizationModeAtom, "chronological");
  store.set(sidebarCollapsedThreadSectionsAtom, [
    "chronological::first",
    "chronological::second",
    "chronological::third",
  ]);
  const current: SidebarThreadRevealInputs = {
    selectedThreadId: "first",
    threads,
    threadsReady: true,
    preferencesReady: true,
    personalProjectId: "proj_personal",
    ...initial,
  };
  function Probe({ inputs }: { inputs: SidebarThreadRevealInputs }) {
    useSidebarThreadRevealCore(inputs);
    return null;
  }
  function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  }
  const hook = renderSlot(
    { component: Wrapper },
    { children: <Probe inputs={current} /> },
    options,
  );
  const update = (next: Partial<SidebarThreadRevealInputs>) => {
    Object.assign(current, next);
    hook.lifecycle.rerender(
      <Wrapper>
        <Probe inputs={{ ...current }} />
      </Wrapper>,
    );
  };
  return { ...hook, store, update };
}

describe("useSidebarThreadReveal", () => {
  it("requires leaving and returning before revealing a manually collapsed open thread", () => {
    const { store, update } = setup([thread("first"), thread("second")]);
    act(() =>
      store.set(sidebarCollapsedThreadSectionsAtom, ["chronological::first"]),
    );

    update({
      threads: [
        thread("first", { title: "Updated", latestAttentionAt: 2 }),
        thread("second"),
      ],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::first",
    ]);

    update({ selectedThreadId: undefined });
    update({ selectedThreadId: "first" });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([]);
  });

  it("reveals only newly unread non-open threads and respects a later manual collapse", () => {
    const { store, update } = setup([
      thread("first"),
      thread("second"),
      thread("third"),
    ]);
    act(() =>
      store.set(sidebarCollapsedThreadSectionsAtom, [
        "chronological::first",
        "chronological::second",
        "chronological::third",
      ]),
    );
    update({
      threads: [
        thread("first", { latestAttentionAt: 2 }),
        thread("second", { latestAttentionAt: 2 }),
        thread("third"),
      ],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::first",
      "chronological::third",
    ]);

    act(() =>
      store.set(sidebarCollapsedThreadSectionsAtom, ["chronological::second"]),
    );
    update({
      threads: [
        thread("first", { latestAttentionAt: 2 }),
        thread("second", { latestAttentionAt: 3 }),
        thread("third"),
      ],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::second",
    ]);

    update({
      threads: [
        thread("first"),
        thread("second", { lastReadAt: 3, latestAttentionAt: 3 }),
        thread("third"),
      ],
    });
    update({
      threads: [
        thread("first"),
        thread("second", { lastReadAt: 3, latestAttentionAt: 4 }),
        thread("third"),
      ],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([]);
  });

  it("keeps initially unread threads collapsed and ignores hidden unread threads", () => {
    const { store, update } = setup([
      thread("first"),
      thread("second", { latestAttentionAt: 2 }),
    ]);
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::second",
      "chronological::third",
    ]);
    update({
      threads: [
        thread("first"),
        thread("second", { latestAttentionAt: 2 }),
        thread("third", { latestAttentionAt: 2, isHidden: true }),
      ],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::second",
      "chronological::third",
    ]);
  });

  it("waits for the threads to be ready before establishing the unread baseline", () => {
    const { store, update } = setup([thread("first")], {
      threadsReady: false,
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toContain(
      "chronological::first",
    );

    update({
      threadsReady: true,
      threads: [thread("first"), thread("second", { latestAttentionAt: 2 })],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::second",
      "chronological::third",
    ]);

    update({ threads: [thread("first"), thread("second")] });
    update({
      threads: [thread("first"), thread("second", { latestAttentionAt: 2 })],
    });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toEqual([
      "chronological::third",
    ]);
  });

  it("reveals the pinned ancestors and environment of a newly unread child", () => {
    const parent = thread("parent", {
      pinnedAt: 1,
      environment: makeSidebarEnvironment({ id: "env_parent" }),
    });
    const child = thread("child", {
      parentThreadId: "parent",
      environment: makeSidebarEnvironment({ id: "env_child" }),
    });
    const { store, update } = setup([thread("first"), parent, child]);
    act(() => {
      store.set(collapsedSidebarSectionIdsAtom, ["pinned"]);
      store.set(collapsedThreadIdsAtom, ["parent"]);
      store.set(collapsedEnvironmentIdsAtom, ["env_parent", "env_child"]);
    });
    update({
      threads: [
        thread("first"),
        parent,
        { ...child, latestAttentionAt: 2, isUnread: true },
      ],
    });
    expect(store.get(collapsedSidebarSectionIdsAtom)).toEqual([]);
    expect(store.get(collapsedThreadIdsAtom)).toEqual([]);
    expect(store.get(collapsedEnvironmentIdsAtom)).toEqual([]);
  });

  it("waits for preferences and the destination thread before revealing navigation", () => {
    const { store, update } = setup([], { preferencesReady: false });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toContain(
      "chronological::first",
    );
    update({ preferencesReady: true });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).toContain(
      "chronological::first",
    );
    update({ threads: [thread("first")] });
    expect(store.get(sidebarCollapsedThreadSectionsAtom)).not.toContain(
      "chronological::first",
    );
  });
});

it("reveals a machine group using the root host when a child belongs to another machine", () => {
  const { store, update } = setup(
    [
      thread("root", { host: { id: "a", name: "A" } }),
      thread("child", { parentThreadId: "root", host: { id: "b", name: "B" } }),
    ],
    { selectedThreadId: undefined },
  );
  act(() => {
    store.set(sidebarOrganizationModeAtom, "machine");
    store.set(sidebarCollapsedMachinesAtom, ["a", "b"]);
  });
  update({ selectedThreadId: "child" });
  expect(store.get(sidebarCollapsedMachinesAtom)).toEqual(["b"]);
});

it.each(["absent", "hook", "projection"] as const)(
  "finishes a pending group reveal after %s recovery and then respects manual collapse",
  async (failure) => {
    let unavailable = true;
    const registration = await loadPluginApp(
      definePluginApp((app) => {
        app.slots.experimental_threadListGrouping({
          id: "groups",
          title: "Groups",
          useData() {
            if (failure === "hook" && unavailable)
              throw new Error("unavailable grouping");
          },
          projection() {
            return failure === "projection" && unavailable
              ? { status: "error" }
              : {
                  status: "ready",
                  group: { key: "saved", label: "Saved group" },
                };
          },
        });
      }),
    );
    const plugins =
      failure === "absent"
        ? []
        : [{ pluginId: "adapter", generation: 1, registrations: registration }];
    const { store, update } = setup(
      [thread("root"), thread("child", { parentThreadId: "root" })],
      { selectedThreadId: undefined },
      { experimental_threadListPlugins: plugins },
    );
    const key = buildContributionGroupKey("adapter/groups", "group", "saved");
    act(() => {
      store.set(sidebarOrganizationModeAtom, "adapter/groups");
      store.set(sidebarCollapsedContributionGroupsAtom, [key]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    update({ selectedThreadId: "child" });
    expect(store.get(sidebarCollapsedContributionGroupsAtom)).toEqual([key]);
    unavailable = false;
    plugins.splice(0, plugins.length, {
      pluginId: "adapter",
      generation: 2,
      registrations: registration,
    });
    update({});
    await waitFor(() =>
      expect(store.get(sidebarCollapsedContributionGroupsAtom)).toEqual([]),
    );
    expect(store.get(sidebarOrganizationModeAtom)).toBe("adapter/groups");
    act(() => store.set(sidebarCollapsedContributionGroupsAtom, [key]));
    update({
      threads: [
        thread("root", { title: "Renamed" }),
        thread("child", { parentThreadId: "root" }),
      ],
    });
    expect(store.get(sidebarCollapsedContributionGroupsAtom)).toEqual([key]);
  },
);
