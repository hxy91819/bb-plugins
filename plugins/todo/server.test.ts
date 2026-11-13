import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import {
  TODO_CHANGED_EVENT,
  type TodoScanResult,
  type TodoSnapshot,
  type TodoItem,
} from "./contract";

function fixture() {
  return createFakePluginHost({
    pluginId: "todo",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          if (threadId === "thr-gone") throw new Error("Thread deleted");
          return makeThreadResponse({
            id: threadId,
            title: `Thread ${threadId}`,
            status: threadId === "thr-running" ? "active" : "idle",
          });
        },
      },
    },
  });
}

async function runJson(
  harness: FakePluginHarness,
  argv: string[],
  ctx?: { threadId?: string },
): Promise<unknown> {
  const result = await harness.behavior.runCli([...argv, "--json"], ctx);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout ?? "null");
}

async function runJsonError(
  harness: FakePluginHarness,
  argv: string[],
  ctx?: { threadId?: string },
): Promise<{ ok: false; error: { code: string; message: string; hint?: string } }> {
  const result = await harness.behavior.runCli([...argv, "--json"], ctx);
  assert.equal(result.exitCode, 1);
  assert.notEqual(result.stderr, "");
  return JSON.parse(result.stdout ?? "null");
}

test("quick add keeps short ids stable across reloads and normalizes t-1 and 1", async () => {
  let { bb, harness } = fixture();
  try {
    await plugin(bb);
    const first = (await runJson(harness, ["add", "Ship the todo plugin"])) as TodoItem;
    const second = (await runJson(harness, [
      "add",
      "Write the release note",
      "--bucket",
      "later",
    ])) as TodoItem;
    const third = (await runJson(harness, [
      "add",
      "Wait for review",
      "--bucket",
      "waiting",
      "--next-step",
      "Ping the reviewer",
    ])) as TodoItem;

    assert.equal(first.id, "T-1");
    assert.equal(first.bucket, "focus");
    assert.equal(second.id, "T-2");
    assert.equal(third.id, "T-3");
    assert.equal(third.nextStep, "Ping the reviewer");
    assert.ok(Number.isNaN(Date.parse(first.createdAt)) === false);

    const lower = (await runJson(harness, ["show", "t-1"])) as TodoItem;
    const numeric = (await runJson(harness, ["show", "1"])) as TodoItem;
    assert.deepEqual(lower, first);
    assert.deepEqual(numeric, first);

    assert.ok(
      harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === TODO_CHANGED_EVENT,
      ),
    );

    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    const listed = (await runJson(harness, ["list"])) as { items: TodoItem[]; count: number };
    assert.deepEqual(
      listed.items.map((item) => item.id),
      ["T-1", "T-2", "T-3"],
    );
    assert.equal(listed.count, 3);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("proposals always enter the inbox and stay out of the default open list", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const formal = (await runJson(harness, ["add", "Existing macro todo"])) as TodoItem;
    const proposal = (await runJson(harness, [
      "propose",
      "Start a design system",
      "--reason",
      "Recurring requests across three projects; own deliverable",
      "--notes",
      "Collect examples first",
    ])) as TodoItem;

    assert.equal(proposal.bucket, "inbox");
    assert.equal(proposal.proposalReason, "Recurring requests across three projects; own deliverable");
    assert.equal(proposal.notes, "Collect examples first");

    const open = (await runJson(harness, ["list"])) as { items: TodoItem[] };
    assert.deepEqual(
      open.items.map((item) => item.id),
      [formal.id],
    );

    const inbox = (await runJson(harness, ["list", "--status", "inbox"])) as {
      items: TodoItem[];
    };
    assert.deepEqual(
      inbox.items.map((item) => item.id),
      [proposal.id],
    );

    const all = (await runJson(harness, ["list", "--status", "all"])) as {
      items: TodoItem[];
    };
    assert.deepEqual(new Set(all.items.map((item) => item.id)), new Set([formal.id, proposal.id]));

    const snapshot = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.equal(snapshot.counts.inbox, 1);
    assert.equal(snapshot.counts.open, 1);
    assert.deepEqual(
      snapshot.buckets.inbox.map((item) => item.id),
      [proposal.id],
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("triage accepts, merges with log and thread inheritance, and dismisses", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const target = (await runJson(harness, ["add", "Ship the todo plugin"])) as TodoItem;

    const acceptProposal = (await runJson(harness, [
      "propose",
      "Draft the README",
      "--reason",
      "Docs are a separate deliverable",
    ])) as TodoItem;
    const accepted = (await runJson(harness, [
      "triage",
      acceptProposal.id,
      "--action",
      "accept",
      "--bucket",
      "later",
    ])) as { action: string; item: TodoItem };
    assert.equal(accepted.action, "accept");
    assert.equal(accepted.item.bucket, "later");
    assert.equal(accepted.item.proposalReason, null);
    assert.match(accepted.item.logs[0].text, /Accepted from inbox: Docs are a separate deliverable/);

    const defaultAcceptProposal = (await runJson(harness, [
      "propose",
      "Renew the domain",
      "--reason",
      "Independent yearly task",
    ])) as TodoItem;
    const defaultAccepted = (await runJson(harness, [
      "triage",
      defaultAcceptProposal.id,
      "--action",
      "accept",
    ])) as { action: string; item: TodoItem };
    assert.equal(defaultAccepted.item.bucket, "focus");

    const mergeProposal = (await runJson(
      harness,
      [
        "propose",
        "Review the README",
        "--reason",
        "Chat excerpt asks for a review",
        "--notes",
        "Typos in the storage section",
        "--link-current",
      ],
      { threadId: "thr-merge" },
    )) as TodoItem;
    assert.deepEqual(
      mergeProposal.threads.map((thread) => thread.threadId),
      ["thr-merge"],
    );

    const merged = (await runJson(harness, [
      "triage",
      mergeProposal.id,
      "--action",
      "merge",
      "--into",
      target.id,
    ])) as { action: string; item: TodoItem };
    assert.equal(merged.action, "merge");
    const mergedLog = merged.item.logs[0].text;
    assert.match(mergedLog, /Review the README/);
    assert.match(mergedLog, /Chat excerpt asks for a review/);
    assert.match(mergedLog, /Typos in the storage section/);
    assert.ok(merged.item.threads.some((thread) => thread.threadId === "thr-merge"));
    assert.equal(merged.item.threads.find((thread) => thread.threadId === "thr-merge")?.threadTitle, "Thread thr-merge");

    const sourceGone = await runJsonError(harness, ["show", mergeProposal.id]);
    assert.equal(sourceGone.error.code, "not_found");

    const dismissProposal = (await runJson(harness, [
      "propose",
      "Buy a pony",
      "--reason",
      "Impulse idea",
    ])) as TodoItem;
    const dismissed = (await runJson(harness, [
      "triage",
      dismissProposal.id,
      "--action",
      "dismiss",
    ])) as { action: string; item: null };
    assert.equal(dismissed.action, "dismiss");
    assert.equal(dismissed.item, null);
    assert.equal((await runJsonError(harness, ["show", dismissProposal.id])).error.code, "not_found");

    const notInbox = await runJsonError(harness, ["triage", target.id, "--action", "accept"]);
    assert.equal(notInbox.error.code, "not_inbox");
    const snapshot = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.equal(snapshot.counts.inbox, 0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("log binds ctx.threadId idempotently and --no-link records without binding", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const item = (await runJson(harness, ["add", "Plan the sprint"])) as TodoItem;
    const ctx = { threadId: "thr-current" };

    const first = (await runJson(
      harness,
      ["log", item.id, "Talked to design", "--next-step", "Send the invite"],
      ctx,
    )) as TodoItem;
    assert.equal(first.logs[0].text, "Talked to design");
    assert.equal(first.logs[0].threadId, "thr-current");
    assert.equal(first.nextStep, "Send the invite");
    assert.equal(first.threads.filter((thread) => thread.threadId === "thr-current").length, 1);

    const second = (await runJson(
      harness,
      ["log", item.id, "Picked a meeting time"],
      ctx,
    )) as TodoItem;
    assert.equal(second.threads.filter((thread) => thread.threadId === "thr-current").length, 1);
    assert.equal(second.logs.length, 2);
    assert.equal(second.logs[0].text, "Picked a meeting time");

    const unlinked = (await runJson(
      harness,
      ["log", item.id, "Offline note", "--no-link"],
      ctx,
    )) as TodoItem;
    assert.equal(unlinked.logs[0].text, "Offline note");
    assert.equal(unlinked.logs[0].threadId, null);
    assert.equal(unlinked.threads.length, 1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("link and unlink default to ctx.threadId and explain a missing thread", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const item = (await runJson(harness, ["add", "Follow up with the reviewer"])) as TodoItem;

    const linked = (await runJson(harness, ["link", item.id], { threadId: "thr-b" })) as TodoItem;
    assert.equal(linked.threads.length, 1);
    assert.equal(linked.threads[0].threadId, "thr-b");
    assert.equal(linked.threads[0].threadTitle, "Thread thr-b");
    assert.equal(linked.threads[0].threadStatus, "idle");

    const unlinked = (await runJson(harness, ["unlink", item.id], { threadId: "thr-b" })) as TodoItem;
    assert.equal(unlinked.threads.length, 0);

    const explicit = (await runJson(harness, ["link", item.id, "--thread", "thr-c", "--note", "review"])) as TodoItem;
    assert.equal(explicit.threads[0].threadId, "thr-c");
    assert.equal(explicit.threads[0].note, "review");

    const missing = await runJsonError(harness, ["link", item.id]);
    assert.equal(missing.error.code, "missing_thread");
    assert.match(missing.error.hint ?? "", /--thread/);

    assert.equal((await runJsonError(harness, ["unlink", "T-99", "--thread", "thr-c"])).error.code, "not_found");
    const explicitUnlinked = (await runJson(harness, ["unlink", item.id, "--thread", "thr-c"])) as TodoItem;
    assert.equal(explicitUnlinked.threads.length, 0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("scan marks running-thread and waiting todos as not actionable", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const alpha = (await runJson(harness, ["add", "Alpha"])) as TodoItem;
    const beta = (await runJson(harness, ["add", "Beta", "--bucket", "later"])) as TodoItem;
    const gamma = (await runJson(harness, ["add", "Gamma", "--bucket", "waiting"])) as TodoItem;
    await runJson(harness, ["propose", "Delta", "--reason", "Separate workstream"]);
    await runJson(harness, ["link", alpha.id, "--thread", "thr-running"]);
    await runJson(harness, ["link", beta.id, "--thread", "thr-idle"]);
    await runJson(harness, ["link", gamma.id, "--thread", "thr-gone"]);
    await runJson(harness, ["log", beta.id, "Beta progress", "--next-step", "Beta next", "--no-link"]);

    const scan = (await runJson(harness, ["scan"])) as TodoScanResult;
    assert.equal(scan.inboxCount, 1);
    assert.deepEqual(
      scan.items.map((item) => item.id),
      [alpha.id, beta.id, gamma.id],
    );
    const byId = new Map(scan.items.map((item) => [item.id, item]));
    assert.equal(byId.get(alpha.id)?.hasRunningThread, true);
    assert.equal(byId.get(alpha.id)?.actionable, false);
    assert.equal(byId.get(beta.id)?.hasRunningThread, false);
    assert.equal(byId.get(beta.id)?.actionable, true);
    assert.equal(byId.get(beta.id)?.latestLog?.text, "Beta progress");
    assert.equal(byId.get(beta.id)?.nextStep, "Beta next");
    assert.equal(byId.get(gamma.id)?.hasRunningThread, false);
    assert.equal(byId.get(gamma.id)?.actionable, false);
    assert.equal(byId.get(gamma.id)?.threads[0].threadId, "thr-gone");
    assert.equal(byId.get(gamma.id)?.threads[0].threadTitle, null);
    assert.equal(byId.get(gamma.id)?.threads[0].threadStatus, null);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("invalid CLI input returns coded JSON errors with hints", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const item = (await runJson(harness, ["add", "A real todo"])) as TodoItem;

    const emptyTitle = await runJsonError(harness, ["add", ""]);
    assert.equal(emptyTitle.error.code, "invalid_input");

    const missing = await runJsonError(harness, ["show", "T-999"]);
    assert.equal(missing.error.code, "not_found");
    assert.ok(missing.error.hint);

    const missingReason = await runJsonError(harness, ["propose", "No reason"]);
    assert.equal(missingReason.error.code, "missing_required");

    const badBucket = await runJsonError(harness, ["list", "--bucket", "someday"]);
    assert.equal(badBucket.error.code, "invalid_value");

    const missingThread = await runJsonError(harness, ["unlink", item.id]);
    assert.equal(missingThread.error.code, "missing_thread");
    assert.ok(missingThread.error.hint);

    const noChange = await runJsonError(harness, ["update", item.id]);
    assert.equal(noChange.error.code, "missing_change");

    const proposal = (await runJson(harness, [
      "propose",
      "Merge me",
      "--reason",
      "Needs a target",
    ])) as TodoItem;
    const noTarget = await runJsonError(harness, ["triage", proposal.id, "--action", "merge"]);
    assert.equal(noTarget.error.code, "missing_into");
    assert.ok(noTarget.error.hint);

    const extraInto = await runJsonError(harness, [
      "triage",
      proposal.id,
      "--action",
      "accept",
      "--into",
      item.id,
    ]);
    assert.equal(extraInto.error.code, "invalid_combination");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("panel RPC creates, updates, completes, reopens, and removes a todo", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const created = (await harness.behavior.callRpc("quickAdd", {
      title: "Panel todo",
    })) as TodoItem;
    assert.equal(created.bucket, "focus");

    const updated = (await harness.behavior.callRpc("update", {
      id: created.id,
      title: "Panel todo v2",
      bucket: "later",
      nextStep: "Review the panel",
    })) as TodoItem;
    assert.equal(updated.title, "Panel todo v2");
    assert.equal(updated.bucket, "later");
    assert.equal(updated.nextStep, "Review the panel");

    const completed = (await harness.behavior.callRpc("setCompleted", {
      id: created.id,
      completed: true,
      note: "Shipped",
    })) as TodoItem;
    assert.ok(completed.completedAt);
    assert.equal(completed.logs[0].text, "Shipped");

    const snapshot = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.equal(snapshot.counts.open, 0);
    assert.equal(snapshot.counts.done, 1);
    assert.deepEqual(
      snapshot.done.map((item) => item.id),
      [created.id],
    );

    const reopened = (await harness.behavior.callRpc("setCompleted", {
      id: created.id,
      completed: false,
    })) as TodoItem;
    assert.equal(reopened.completedAt, null);

    const removed = (await harness.behavior.callRpc("remove", { id: created.id })) as {
      removed: boolean;
    };
    assert.equal(removed.removed, true);
    await assert.rejects(harness.behavior.callRpc("update", { id: created.id, title: "Gone" }));
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("package imports only public SDK surfaces", async () => {
  const result = await experimental_scanPublicSdkOnly(process.cwd(), {
    allow: [/^react$/, /^zod$/],
  });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.privateDependencies, []);
});
