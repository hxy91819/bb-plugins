import { describe, expect, it } from "vitest";
import {
  makeSidebarEnvironment,
  makeSidebarThread,
  type SidebarThreadOverrides,
} from "./fixtures.js";
import {
  buildMachineThreadGroups,
  NO_MACHINE_GROUP_KEY,
} from "./machine-thread-groups.js";
import { buildContributedThreadGroups } from "./contributed-thread-groups.js";
import {
  buildProjectThreadGroups,
  getProjectThreadItemDescendants,
} from "./project-thread-groups.js";
import type { SidebarThread } from "./sidebar-thread.js";

function createThread(overrides: SidebarThreadOverrides): SidebarThread {
  return makeSidebarThread({
    id: "thr_1",
    projectId: "proj_1",
    title: "Thread",
    titleFallback: "Thread",
    lastReadAt: 0,
    latestAttentionAt: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
}

function createHost(host: { id: string; name: string }) {
  return host;
}

describe("buildMachineThreadGroups", () => {
  it("orders known hosts by server order, then unknown hosts, then no-machine", () => {
    const hosts = [
      createHost({ id: "host_a", name: "Laptop" }),
      createHost({ id: "host_b", name: "Desktop" }),
    ];
    const threads = [
      createThread({ id: "thr_1", host: { id: "host_b", name: "host_b" } }),
      createThread({ id: "thr_2", host: null }),
      createThread({
        id: "thr_3",
        host: { id: "host_gone", name: "host_gone" },
      }),
      createThread({ id: "thr_4", host: { id: "host_a", name: "host_a" } }),
      createThread({ id: "thr_5", host: { id: "host_b", name: "host_b" } }),
    ];

    const groups = buildMachineThreadGroups(threads, hosts);

    expect(
      groups.map((group) => ({
        key: group.key,
        label: group.label,
        threadIds: group.threads.map((thread) => thread.id),
      })),
    ).toEqual([
      { key: "host_a", label: "Laptop", threadIds: ["thr_4"] },
      { key: "host_b", label: "Desktop", threadIds: ["thr_1", "thr_5"] },
      { key: "host_gone", label: "Unknown machine", threadIds: ["thr_3"] },
      { key: NO_MACHINE_GROUP_KEY, label: "No machine", threadIds: ["thr_2"] },
    ]);
  });

  it("shows machines that have no threads and omits the no-machine group when empty", () => {
    const hosts = [
      createHost({ id: "host_a", name: "Laptop" }),
      createHost({ id: "host_b", name: "Desktop" }),
    ];
    const threads = [
      createThread({ id: "thr_1", host: { id: "host_b", name: "host_b" } }),
    ];

    const groups = buildMachineThreadGroups(threads, hosts);

    expect(
      groups.map((group) => ({ key: group.key, threads: group.threads })),
    ).toEqual([
      { key: "host_a", threads: [] },
      { key: "host_b", threads },
    ]);
  });

  it("falls back to id-ordered unknown groups when the host list is empty", () => {
    const threads = [
      createThread({ id: "thr_1", host: { id: "host_b", name: "host_b" } }),
      createThread({ id: "thr_2", host: { id: "host_a", name: "host_a" } }),
    ];

    const groups = buildMachineThreadGroups(threads, []);

    expect(groups.map((group) => group.key)).toEqual(["host_a", "host_b"]);
  });
});

describe.each([
  {
    name: "machine",
    build: (threads: SidebarThread[]) =>
      buildMachineThreadGroups(threads, [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ]),
  },
  {
    name: "public contribution",
    build: (threads: SidebarThread[]) =>
      buildContributedThreadGroups(threads, "adapter/owners", (thread) => ({
        status: "ready",
        group: {
          key: thread.host?.id ?? "none",
          label: thread.host?.name ?? "None",
        },
      })).groups,
  },
])("$name root projection", ({ build }) => {
  it("keeps a cross-group child in its root tree and does not merge the same environment across groups", () => {
    const environment = makeSidebarEnvironment({
      id: "shared",
      isWorktree: true,
    });
    const input = [
      createThread({ id: "root-a", host: { id: "a", name: "A" }, environment }),
      createThread({
        id: "child-b",
        parentThreadId: "root-a",
        host: { id: "b", name: "B" },
        environment,
      }),
      createThread({ id: "root-b", host: { id: "b", name: "B" }, environment }),
      createThread({
        id: "root-a2",
        host: { id: "a", name: "A" },
        environment,
      }),
    ];
    const groups = build(input);
    const a = groups.find((group) => group.label === "A");
    const b = groups.find((group) => group.label === "B");
    expect(a?.threads.map((thread) => thread.id).sort()).toEqual([
      "child-b",
      "root-a",
      "root-a2",
    ]);
    expect(b?.threads.map((thread) => thread.id)).toEqual(["root-b"]);
    const aTree = buildProjectThreadGroups(a?.threads ?? []);
    const bTree = buildProjectThreadGroups(b?.threads ?? []);
    expect(aTree[0]?.kind).toBe("environment");
    expect(bTree[0]?.kind).toBe("thread");
    expect(
      getProjectThreadItemDescendants([...aTree, ...bTree])
        .map((thread) => thread.id)
        .sort(),
    ).toEqual(input.map((thread) => thread.id).sort());
    expect(input[1].host?.id).toBe("b");
  });
});
