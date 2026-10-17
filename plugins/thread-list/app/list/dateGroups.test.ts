import { describe, expect, it, vi } from "vitest";
import {
  buildSectionThreadList,
  type ProjectThreadItem,
} from "../model/project-thread-groups.js";
import {
  makeSidebarEnvironment,
  makeSidebarThread,
} from "../model/fixtures.js";
import { getDateGroupLabels } from "./dateGroups.js";

function itemsAt(...dates: Date[]): ProjectThreadItem[] {
  return buildSectionThreadList(
    dates.map((date, index) =>
      makeSidebarThread({
        id: `thr_${index}`,
        createdAt: date.getTime(),
        latestAttentionAt: date.getTime(),
      }),
    ),
    () => 0,
    [],
    false,
  );
}

describe("date groups", () => {
  it("counts local calendar days across daylight saving transitions", () => {
    vi.stubEnv("TZ", "America/New_York");
    try {
      expect(
        getDateGroupLabels(
          itemsAt(new Date(2026, 10, 1, 0)),
          "updated",
          new Date(2026, 10, 2, 0, 30),
        ),
      ).toEqual(["Yesterday"]);
      expect(
        getDateGroupLabels(
          itemsAt(new Date(2026, 2, 7, 23, 59)),
          "updated",
          new Date(2026, 2, 9, 0, 30),
        ),
      ).toEqual(["Saturday"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses local midnight rather than elapsed 24-hour periods", () => {
    const items = itemsAt(
      new Date(2026, 9, 1, 0),
      new Date(2026, 8, 30, 23, 59, 59, 999),
    );
    expect(
      getDateGroupLabels(items, "updated", new Date(2026, 9, 1, 0, 0, 1)),
    ).toEqual(["Today", "Yesterday"]);
    expect(
      getDateGroupLabels(items, "updated", new Date(2026, 9, 2, 0)),
    ).toEqual(["Yesterday", "Wednesday"]);
  });

  it("labels both sides of the 2, 7, and 30-day boundaries and keeps same-month buckets distinct", () => {
    const now = new Date(2026, 9, 31, 12);
    const items = itemsAt(
      new Date(2026, 9, 31),
      new Date(2026, 9, 31, 9),
      new Date(2026, 9, 30),
      new Date(2026, 9, 29),
      new Date(2026, 9, 25),
      new Date(2026, 9, 24),
      new Date(2026, 9, 2),
      new Date(2026, 9, 1),
      new Date(2026, 8, 30),
      new Date(2026, 8, 1),
      new Date(2025, 8, 1),
    );
    expect(getDateGroupLabels(items, "updated", now)).toEqual([
      "Today",
      null,
      "Yesterday",
      "Thursday",
      "Sunday",
      "Previous 30 days",
      null,
      "October 2026",
      "September 2026",
      null,
      "September 2025",
    ]);
    expect(getDateGroupLabels([...items].reverse(), "updated", now)).toEqual([
      "September 2025",
      "September 2026",
      null,
      "October 2026",
      "Previous 30 days",
      null,
      "Sunday",
      "Thursday",
      "Yesterday",
      "Today",
      null,
    ]);
  });

  it("groups updated sorting by latest activity so metadata edits do not move a thread", () => {
    const now = new Date(2026, 9, 3, 12);
    const items = buildSectionThreadList(
      [
        makeSidebarThread({
          id: "thr_unpinned",
          createdAt: new Date(2026, 8, 24).getTime(),
          latestAttentionAt: new Date(2026, 9, 1, 9).getTime(),
          updatedAt: now.getTime(),
        }),
      ],
      () => 0,
      [],
      false,
    );
    expect(getDateGroupLabels(items, "updated", now)).toEqual(["Thursday"]);
  });

  it("counts running threads as today even when their last attention is older", () => {
    const now = new Date(2026, 9, 3, 12);
    const items = buildSectionThreadList(
      [
        makeSidebarThread({
          id: "thr_running",
          status: "active",
          createdAt: new Date(2026, 9, 1).getTime(),
          latestAttentionAt: new Date(2026, 9, 1).getTime(),
        }),
        makeSidebarThread({
          id: "thr_idle",
          createdAt: new Date(2026, 9, 1, 8).getTime(),
          latestAttentionAt: new Date(2026, 9, 2).getTime(),
        }),
      ],
      (left, right) => (left.id === "thr_running" ? -1 : right.id === "thr_running" ? 1 : 0),
      [],
      false,
    );
    expect(items.map((item) => item.kind === "thread" && item.node.thread.id)).toEqual([
      "thr_running",
      "thr_idle",
    ]);
    expect(getDateGroupLabels(items, "updated", now)).toEqual([
      "Today",
      "Yesterday",
    ]);
    expect(getDateGroupLabels(items, "created", now)).toEqual([
      "Thursday",
      null,
    ]);
  });

  it("follows the sort field, not archive status, and omits alphabetical headings", () => {
    const items = buildSectionThreadList(
      [
        makeSidebarThread({
          id: "thr_a",
          createdAt: new Date(2025, 11, 1).getTime(),
          latestAttentionAt: new Date(2026, 0, 10).getTime(),
        }),
        makeSidebarThread({
          id: "thr_b",
          createdAt: new Date(2025, 11, 2).getTime(),
          latestAttentionAt: new Date(2026, 0, 10).getTime(),
          archivedAt: 1,
        }),
      ],
      () => 0,
      [],
      false,
    );
    const now = new Date(2026, 0, 10, 12);
    expect(getDateGroupLabels(items, "updated", now)).toEqual(["Today", null]);
    expect(getDateGroupLabels(items, "created", now)).toEqual([
      "December 2025",
      null,
    ]);
    expect(getDateGroupLabels(items, "alpha", now)).toEqual([null, null]);
  });

  it("keeps descendants and environment siblings under the root representative's date", () => {
    const old = new Date(2025, 11, 1).getTime();
    const recent = new Date(2026, 0, 10).getTime();
    const items = buildSectionThreadList(
      [
        makeSidebarThread({ id: "thr_parent", latestAttentionAt: old }),
        makeSidebarThread({
          id: "thr_child",
          parentThreadId: "thr_parent",
          latestAttentionAt: recent,
        }),
        makeSidebarThread({
          id: "thr_env_a",
          environment: makeSidebarEnvironment({
            id: "env_a",
            isWorktree: true,
          }),
          latestAttentionAt: old,
        }),
        makeSidebarThread({
          id: "thr_env_b",
          environment: makeSidebarEnvironment({
            id: "env_a",
            isWorktree: true,
          }),
          latestAttentionAt: recent,
        }),
      ],
      () => 0,
      [],
      true,
    );
    expect(items.map((item) => item.kind)).toEqual(["thread", "environment"]);
    expect(getDateGroupLabels(items, "updated", new Date(2026, 0, 10))).toEqual(
      ["December 2025", null],
    );
  });
});
