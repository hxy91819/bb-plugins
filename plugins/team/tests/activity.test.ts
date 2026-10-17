import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { ExperimentalThreadActivityResult } from "@get-bb/plugin-sdk";
import plugin from "../server.js";
import { activityOutput, rpcContract } from "../src/contracts.js";

const coverage: ExperimentalThreadActivityResult["coverage"] = {
  asOf: 1800000000000,
  from: 0,
  to: 1800000000000,
  forkBoundaryGaps: {
    count: 1,
    missingIdentityCount: 1,
    uncertainPrefixCount: 0,
    samples: [
      { projectId: "p", threadId: "gap", reason: "missing-local-identity" },
    ],
  },
  includesArchived: true,
  includesHidden: true,
  incomplete: true,
  limitations: ["retained evidence only"],
  pagination: "live-pagination",
  source: "retained-events",
  throughSequence: null,
};
const summary: ExperimentalThreadActivityResult = {
  mode: "summary",
  budget: { encoding: "compact-json-utf8", maxBytes: 262144 },
  coverage,
  totalThreads: 3,
  returned: 3,
  hasMore: false,
  truncated: false,
  nextCursor: null,
  items: ["a", "b", "c"].map((threadId) => ({
    threadId,
    projectId: "p",
    title: "Thread " + threadId,
    acceptedInputs: 1,
    completedTurns: 0,
    counts: [{ type: "agentMessage", status: "statement", count: 1 }],
    lastActivityAt: 100,
    cursorAfter: threadId,
    recentEvidence: [
      {
        commandName: null,
        createdAt: 100,
        eventId: "e" + threadId,
        excerpt: '😀\\"'.repeat(100),
        excerptTruncated: false,
        exitCode: null,
        filePath: null,
        outcome: "unknown",
        sequence: 1,
        status: "statement",
        threadId,
        type: "agentMessage",
      },
    ],
  })),
};

test("activity RPC/CLI freezes DST dates, preserves coverage and resumes after the last serialized item", async () => {
  let { harness, bb } = createFakePluginHost({
    pluginId: "team",
    settings: { timezone: "America/New_York" },
  });
  await plugin(bb);
  try {
    const init = rpcContract.initialize.output.parse(
      await harness.behavior.callRpc("initialize", {}),
    );
    if (init.status !== "already_initialized") throw Error("init");
    const member = init.adminMemberId;
    const activityFixture = async (args: {
      cursor?: string;
      from: number;
      to: number;
    }) => ({
      ...summary,
      coverage: { ...coverage, from: args.from, to: args.to },
      items: summary.items.filter(
        (item) => !args.cursor || item.threadId > args.cursor,
      ),
    });
    harness.inspection.sdk.stub(
      "threads.experimental_activity",
      activityFixture,
    );
    const call = async (input: unknown) =>
      activityOutput.parse(await harness.behavior.callRpc("activity", input));
    const spring = await call({
      memberId: member,
      date: "2026-03-08",
      maxChars: 4000,
    });
    expect(spring.query.from).toBe(Date.parse("2026-03-08T05:00:00Z"));
    expect(spring.query.to).toBe(Date.parse("2026-03-09T04:00:00Z"));
    expect(spring.items.map((item) => item.threadId)).toEqual(["a", "b"]);
    expect(spring.hasMore).toBe(true);
    expect(spring.truncated).toBe(true);
    expect(Array.from(JSON.stringify(spring)).length).toBeLessThanOrEqual(4000);
    expect(spring.coverage.forkBoundaryGaps).toEqual(coverage.forkBoundaryGaps);
    expect(spring.nextCursor).toBe(spring.items[1]!.cursorAfter);
    await harness.behavior.setSettings({ timezone: "UTC" });
    ({ harness, bb } = await harness.lifecycle.reload(plugin));
    harness.inspection.sdk.stub(
      "threads.experimental_activity",
      activityFixture,
    );
    const next = await call({ cursor: spring.nextCursor, maxChars: 24000 });
    expect(next.query).toEqual(spring.query);
    expect(next.items.map((item) => item.threadId)).toEqual(["c"]);
    expect(next.hasMore).toBe(false);
    expect(next.nextCursor).toBeNull();
    await expect(
      call({ cursor: spring.nextCursor, date: "2026-03-09" }),
    ).rejects.toThrow();
    await harness.behavior.setSettings({ timezone: "America/New_York" });
    const fall = await call({ memberId: member, date: "2026-11-01" });
    expect(fall.query.from).toBe(Date.parse("2026-11-01T04:00:00Z"));
    expect(fall.query.to).toBe(Date.parse("2026-11-02T05:00:00Z"));
    await expect(
      call({ memberId: member, date: "2026-02-30" }),
    ).rejects.toThrow();
    await expect(
      call({ memberId: member, toDate: "2026-10-15" }),
    ).rejects.toThrow();
    const cli = await harness.behavior.runCli([
      "activity",
      "--member",
      member,
      "--date",
      "2026-03-08",
      "--max-chars",
      "4000",
      "--json",
    ]);
    expect(cli.exitCode).toBe(0);
    expect(Array.from(cli.stdout ?? "").length).toBeLessThanOrEqual(4000);
    expect(activityOutput.parse(JSON.parse(cli.stdout!)).items).toHaveLength(2);
    await harness.behavior.callRpc("members_create", {
      actorMemberId: member,
      displayName: "A",
    });
    await harness.behavior.callRpc("members_create", {
      actorMemberId: member,
      displayName: "A",
    });
    const ambiguous = await harness.behavior.runCli([
      "activity",
      "--name",
      "A",
    ]);
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain("ambiguous");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("creation attribution distinguishes explicit null, parent inheritance, and fork source", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "team" });
  await plugin(bb);
  try {
    const init = rpcContract.initialize.output.parse(
      await harness.behavior.callRpc("initialize", {}),
    );
    if (init.status !== "already_initialized") throw Error("init");
    const memberId = init.adminMemberId;
    const base = {
      creation: {
        projectId: "p",
        origin: null,
        originPluginId: null,
        originKind: null,
        parentThreadId: null,
        sourceThreadId: null,
        startedOnBehalfOf: null,
      },
      legacySeed: null,
      parentMetadata: { memberId },
      sourceMetadata: { memberId },
    };
    const prepare = harness.behavior.experimental_prepareThreadCreationContext;
    expect(
      await prepare({
        ...base,
        context: { present: true, value: { memberId } },
      }),
    ).toEqual({ memberId });
    expect(await prepare({ ...base, context: { present: false } })).toBeNull();
    expect(
      await prepare({
        ...base,
        creation: {
          ...base.creation,
          sourceThreadId: "source",
          originKind: "fork",
        },
        context: { present: false },
      }),
    ).toBeNull();
    expect(
      await prepare({
        ...base,
        creation: { ...base.creation, parentThreadId: "parent" },
        context: { present: false },
      }),
    ).toEqual({ memberId });
    expect(
      await prepare({
        ...base,
        creation: { ...base.creation, parentThreadId: "parent" },
        context: { present: true, value: { memberId: null } },
      }),
    ).toBeNull();
    await expect(
      prepare({
        ...base,
        context: {
          present: true,
          value: { memberId: "00000000-0000-4000-8000-000000000000" },
        },
      }),
    ).rejects.toThrow("no longer exists");
    await expect(
      prepare({
        ...base,
        context: { present: true, value: { memberId: "invalid" } },
      }),
    ).rejects.toThrow();
  } finally {
    await harness.lifecycle.dispose();
  }
});
