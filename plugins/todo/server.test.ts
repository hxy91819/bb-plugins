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
  TODO_COLORS,
  fallbackTodoColor,
  parseTitlePrefix,
  type TodoRevision,
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
  ctx?: { threadId?: string; projectId?: string },
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

async function runText(
  harness: FakePluginHarness,
  argv: string[],
  ctx?: { threadId?: string },
): Promise<string> {
  const result = await harness.behavior.runCli(argv, ctx);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout ?? "";
}

test("quick add keeps short ids stable across reloads and folds legacy --next-step into notes", async () => {
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
    assert.equal(third.notes, "Ping the reviewer");
    assert.equal(Object.hasOwn(third, "nextStep"), false);
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

test("CLI text output stays clean and legacy --next-step merges into notes on update and propose", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const item = (await runJson(harness, [
      "add",
      "Ship the plugin",
      "--list",
      "LightSpace",
      "--section",
      "Hosting Station",
    ])) as TodoItem;
    const listText = await runText(harness, ["list"]);
    assert.match(
      listText,
      /^T-1  focus  \[LightSpace\/Hosting Station\]  Ship the plugin$/m,
    );
    assert.equal(listText.includes("next:"), false);

    const proposal = (await runJson(harness, [
      "propose",
      "Review the README",
      "--reason",
      "Docs are a separate deliverable",
      "--next-step",
      "Check typos",
    ])) as TodoItem;
    assert.equal(proposal.notes, "Check typos");

    const updated = (await runJson(harness, [
      "update",
      item.id,
      "--next-step",
      "Add acceptance notes",
    ])) as TodoItem;
    assert.equal(updated.notes, "Add acceptance notes");
    assert.equal(Object.hasOwn(updated, "nextStep"), false);

    const scanText = await runText(harness, ["scan"]);
    assert.match(
      scanText,
      /^T-1  focus  \[LightSpace\/Hosting Station\]  Ship the plugin  \[actionable\]$/m,
    );
    assert.equal(/next:/.test(scanText), false);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("startup folds legacy next_step into notes and clears it idempotently", async () => {
  let { bb, harness } = fixture();
  try {
    await plugin(bb);
    const item = (await runJson(harness, ["add", "Legacy todo"])) as TodoItem;
    let db = bb.storage.database();
    db.prepare("UPDATE todo_items SET notes = ?, next_step = ? WHERE seq = ?").run(
      "Existing context",
      "Old action",
      item.seq,
    );

    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    const migrated = (await runJson(harness, ["show", item.id])) as TodoItem;
    assert.equal(migrated.notes, "Existing context\n\nOld action");
    assert.equal(Object.hasOwn(migrated, "nextStep"), false);
    db = bb.storage.database();
    let row = db
      .prepare("SELECT notes, next_step FROM todo_items WHERE seq = ?")
      .get(item.seq) as { notes: string; next_step: string };
    assert.equal(row.next_step, "");

    // A note that already contains the old text is not duplicated.
    db.prepare("UPDATE todo_items SET notes = ?, next_step = ? WHERE seq = ?").run(
      "Existing context\n\nOld action",
      "Old action",
      item.seq,
    );
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    const unchanged = (await runJson(harness, ["show", item.id])) as TodoItem;
    assert.equal(unchanged.notes, "Existing context\n\nOld action");
    db = bb.storage.database();
    row = db
      .prepare("SELECT notes, next_step FROM todo_items WHERE seq = ?")
      .get(item.seq) as { notes: string; next_step: string };
    assert.equal(row.next_step, "");

    // Later starts are a no-op once the legacy column is empty.
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    const stable = (await runJson(harness, ["show", item.id])) as TodoItem;
    assert.equal(stable.notes, "Existing context\n\nOld action");
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
    assert.equal(first.notes, "Send the invite");
    assert.equal(Object.hasOwn(first, "nextStep"), false);
    assert.equal(first.threads.filter((thread) => thread.threadId === "thr-current").length, 1);

    const second = (await runJson(
      harness,
      ["log", item.id, "Picked a meeting time"],
      ctx,
    )) as TodoItem;
    assert.equal(second.threads.filter((thread) => thread.threadId === "thr-current").length, 1);
    assert.equal(second.logs.length, 2);
    assert.equal(second.logs[0].text, "Picked a meeting time");
    assert.equal(second.notes, "Send the invite");

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
    assert.equal(Object.hasOwn(byId.get(beta.id) ?? {}, "nextStep"), false);
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
      notes: "Review the panel",
    })) as TodoItem;
    assert.equal(updated.title, "Panel todo v2");
    assert.equal(updated.bucket, "later");
    assert.equal(updated.notes, "Review the panel");

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

test("merge keeps source logs and notes, and does not clobber thread notes", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const target = (await runJson(harness, ["add", "Ship the plugin"])) as TodoItem;
    await runJson(harness, ["link", target.id, "--thread", "thr-shared", "--note", "target note"]);
    await runJson(harness, ["link", target.id, "--thread", "thr-fill"]);
    await runJson(harness, ["link", target.id, "--thread", "thr-both", "--note", "target keeps"]);
    await runJson(harness, ["log", target.id, "target kept", "--no-link"]);

    const proposal = (await runJson(harness, [
      "propose",
      "Review the README",
      "--reason",
      "from chat",
      "--notes",
      "typos",
      "--next-step",
      "Ship the patch",
    ])) as TodoItem;
    assert.equal(proposal.notes, "typos\n\nShip the patch");
    const logged = (await runJson(
      harness,
      ["log", proposal.id, "source progress"],
      { threadId: "thr-source" },
    )) as TodoItem;
    const sourceLog = logged.logs.find((entry) => entry.text === "source progress");
    assert.ok(sourceLog);
    await runJson(harness, ["link", proposal.id, "--thread", "thr-shared"]);
    await runJson(harness, ["link", proposal.id, "--thread", "thr-fill", "--note", "from source"]);
    await runJson(harness, ["link", proposal.id, "--thread", "thr-both", "--note", "source note"]);

    const merged = (await runJson(harness, [
      "triage",
      proposal.id,
      "--action",
      "merge",
      "--into",
      target.id,
    ])) as { action: string; item: TodoItem };
    assert.equal(merged.action, "merge");
    assert.equal(merged.item.notes, "");
    assert.equal(Object.hasOwn(merged.item, "nextStep"), false);
    const kept = merged.item.logs.find((entry) => entry.text === "source progress");
    assert.ok(kept);
    assert.equal(kept.createdAt, sourceLog.createdAt);
    assert.equal(kept.threadId, "thr-source");
    assert.equal(kept.id, sourceLog.id);
    assert.match(merged.item.logs[0].text, /Merged inbox proposal: Review the README/);
    assert.match(merged.item.logs[0].text, /Notes: typos/);
    assert.match(merged.item.logs[0].text, /Ship the patch/);
    assert.equal(/Next step:/.test(merged.item.logs[0].text), false);
    assert.ok(merged.item.logs.some((entry) => entry.text === "target kept"));
    const noteOf = (threadId: string) =>
      merged.item.threads.find((thread) => thread.threadId === threadId)?.note;
    assert.equal(noteOf("thr-shared"), "target note");
    assert.equal(noteOf("thr-fill"), "from source");
    assert.equal(noteOf("thr-both"), "target keeps");
    assert.equal((await runJsonError(harness, ["show", proposal.id])).error.code, "not_found");

    const followUp = (await runJson(harness, [
      "propose",
      "Do not overwrite",
      "--reason",
      "another excerpt",
      "--next-step",
      "Do not replace",
    ])) as TodoItem;
    const second = (await runJson(harness, [
      "triage",
      followUp.id,
      "--action",
      "merge",
      "--into",
      target.id,
    ])) as { item: TodoItem };
    assert.equal(second.item.notes, "");
    assert.match(second.item.logs[0].text, /Notes: Do not replace/);
    assert.equal(/Next step:/.test(second.item.logs[0].text), false);

    await harness.behavior.callRpc("linkThread", {
      id: target.id,
      threadId: "thr-shared",
      note: "",
    });
    const afterEmptyRpc = (await runJson(harness, ["show", target.id])) as TodoItem;
    assert.equal(
      afterEmptyRpc.threads.find((thread) => thread.threadId === "thr-shared")?.note,
      "target note",
    );
    await runJson(harness, ["link", target.id, "--thread", "thr-shared", "--note", ""]);
    await runJson(harness, ["log", target.id, "still linked"], { threadId: "thr-shared" });
    const afterLog = (await runJson(harness, ["show", target.id])) as TodoItem;
    assert.equal(
      afterLog.threads.find((thread) => thread.threadId === "thr-shared")?.note,
      "target note",
    );
    const replaced = (await runJson(harness, [
      "link",
      target.id,
      "--thread",
      "thr-shared",
      "--note",
      "replaced on purpose",
    ])) as TodoItem;
    assert.equal(
      replaced.threads.find((thread) => thread.threadId === "thr-shared")?.note,
      "replaced on purpose",
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("prepareStartSession quotes linked threads and a project without failing closed reads", async () => {
  const threads = new Map([
    ["thr-active", { status: "active" as const, projectId: "proj-active", environmentId: "env-active" }],
    ["thr-mid", { status: "idle" as const, projectId: "proj-mid", environmentId: "env-mid" }],
    ["thr-new", { status: "idle" as const, projectId: "proj-new", environmentId: "env-new" }],
    ["thr-env-fallback", { status: "idle" as const, projectId: "proj-fallback", environmentId: null }],
  ]);
  const { bb, harness } = createFakePluginHost({
    pluginId: "todo",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          if (threadId.startsWith("thr-cap-")) throw new Error("cap thread unread");
          const known = threads.get(threadId);
          const response = makeThreadResponse({
            id: threadId,
            title: `Thread ${threadId}`,
            status: known?.status ?? "idle",
            projectId: known?.projectId ?? "proj-default",
            environmentId: known ? known.environmentId : "env-default",
          });
          if (threadId !== "thr-env-fallback") return response;
          return Object.assign(response, { environment: { id: "env-included" } });
        },
        output: async ({ threadId }) => {
          if (threadId === "thr-mid") throw new Error("output unavailable");
          if (threadId === "thr-active") return { output: ` ${"x".repeat(450)} ` };
          if (threadId === "thr-new") return { output: "tail thr-new" };
          return { output: null };
        },
      },
    },
  });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
  try {
    await plugin(bb);
    const linked = (await runJson(harness, [
      "add",
      "Ship the linked todo",
      "--list",
      "LightSpace",
      "--section",
      "Hosting Station",
      "--next-step",
      "Write tests",
    ])) as TodoItem;
    assert.equal(linked.notes, "Write tests");
    await runJson(harness, ["link", linked.id, "--thread", "thr-active", "--note", "running"]);
    await pause();
    await runJson(harness, ["link", linked.id, "--thread", "thr-mid"]);
    await pause();
    await runJson(harness, ["link", linked.id, "--thread", "thr-new"]);

    const prepared = (await harness.behavior.callRpc("prepareStartSession", {
      id: linked.id,
    })) as {
      itemId: string;
      projectId: string | null;
      environmentId: string | null;
      initialPrompt: string;
      relatedThreadCount: number;
    };
    assert.equal(prepared.itemId, linked.id);
    assert.equal(prepared.relatedThreadCount, 3);
    assert.equal(prepared.projectId, "proj-new");
    assert.equal(prepared.environmentId, "env-new");
    assert.ok(prepared.initialPrompt.length <= 3000);
    assert.match(prepared.initialPrompt, new RegExp(`推进待办 ${linked.id}：Ship the linked todo`));
    assert.match(prepared.initialPrompt, /清单：LightSpace \/ Hosting Station/);
    assert.match(prepared.initialPrompt, /备注：\nWrite tests/);
    assert.equal(/下一步：/.test(prepared.initialPrompt), false);
    assert.match(prepared.initialPrompt, /bb todo link/);
    assert.match(prepared.initialPrompt, /bb todo log/);
    const quoted = [...prepared.initialPrompt.matchAll(/^@thread:(\S+)$/gm)].map((match) => match[1]);
    assert.deepEqual(quoted, ["thr-active", "thr-new", "thr-mid"]);
    assert.equal(prepared.initialPrompt.includes("x".repeat(450)), false);
    assert.equal(prepared.initialPrompt.includes(`…${"x".repeat(399)}`), true);
    assert.match(prepared.initialPrompt, /tail thr-new/);
    assert.equal(prepared.initialPrompt.includes("output unavailable"), false);

    const capped = (await runJson(harness, ["add", "Too many threads"])) as TodoItem;
    for (const index of [0, 1, 2, 3, 4, 5]) {
      await pause();
      await runJson(harness, ["link", capped.id, "--thread", `thr-cap-${index}`]);
    }
    const cappedPrompt = (await harness.behavior.callRpc("prepareStartSession", {
      id: capped.id,
    })) as { relatedThreadCount: number; initialPrompt: string; projectId: string | null };
    assert.equal(cappedPrompt.relatedThreadCount, 5);
    assert.equal(cappedPrompt.projectId, null);
    const cappedIds = [...cappedPrompt.initialPrompt.matchAll(/^@thread:(\S+)$/gm)].map((match) => match[1]);
    assert.deepEqual(cappedIds, ["thr-cap-5", "thr-cap-4", "thr-cap-3", "thr-cap-2", "thr-cap-1"]);
    assert.match(cappedPrompt.initialPrompt, /其余 1 个关联会话/);

    const fallback = (await runJson(harness, ["add", "Fallback env"])) as TodoItem;
    await runJson(harness, ["link", fallback.id, "--thread", "thr-env-fallback"]);
    const fromInclude = (await harness.behavior.callRpc("prepareStartSession", {
      id: fallback.id,
    })) as { projectId: string | null; environmentId: string | null; initialPrompt: string };
    assert.equal(fromInclude.projectId, "proj-fallback");
    assert.equal(fromInclude.environmentId, "env-included");
    assert.match(fromInclude.initialPrompt, /@thread:thr-env-fallback/);

    const plain = (await runJson(harness, [
      "add",
      "Plain todo",
      "--notes",
      "注".repeat(900),
      "--next-step",
      "Summarize the note",
    ])) as TodoItem;
    assert.match(plain.notes, /^注{900}\n\nSummarize the note$/);
    const bare = (await harness.behavior.callRpc("prepareStartSession", { id: plain.id })) as {
      projectId: string | null;
      environmentId: string | null;
      initialPrompt: string;
      relatedThreadCount: number;
    };
    assert.equal(bare.relatedThreadCount, 0);
    assert.equal(bare.projectId, null);
    assert.equal(bare.environmentId, null);
    assert.equal(/@thread:/.test(bare.initialPrompt), false);
    assert.match(bare.initialPrompt, /推进待办/);
    assert.equal(/下一步：/.test(bare.initialPrompt), false);
    assert.match(bare.initialPrompt, new RegExp(`bb todo show ${plain.id}`));
    assert.equal(bare.initialPrompt.includes("注".repeat(900)), false);
    assert.ok(bare.initialPrompt.length <= 3000);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("bb todo start spawns a thread and links it back", async () => {
  const spawned: Array<{
    projectId: string;
    title?: string;
    prompt: string;
    environment: { type: string };
  }> = [];
  let spawnedCount = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "todo",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            title: `Thread ${threadId}`,
            status: "idle",
            projectId: threadId === "thr-related" ? "proj-from-thread" : "proj-spawned",
            environmentId: threadId === "thr-related" ? "env-related" : null,
          }),
        output: async ({ threadId }) =>
          threadId === "thr-related" ? { output: "最近在改测试" } : { output: null },
        spawn: async (args) => {
          spawnedCount += 1;
          spawned.push({
            projectId: args.projectId,
            title: args.title,
            prompt: args.prompt ?? "",
            environment: args.environment,
          });
          return makeThreadResponse({
            id: `thr-spawned-${spawnedCount}`,
            title: args.title ?? null,
            projectId: args.projectId,
            status: "starting",
          });
        },
      },
    },
  });
  try {
    await plugin(bb);
    const bare = (await runJson(harness, ["add", "Needs a project"])) as TodoItem;
    const missing = await runJsonError(harness, ["start", bare.id]);
    assert.equal(missing.error.code, "missing_project");
    assert.match(missing.error.hint ?? "", /--project/);
    assert.equal(spawned.length, 0);

    const fromContext = (await runJson(harness, ["start", bare.id], {
      projectId: "proj-ctx",
    })) as { threadId: string; projectId: string; item: TodoItem };
    assert.equal(fromContext.projectId, "proj-ctx");
    assert.equal(fromContext.threadId, "thr-spawned-1");
    assert.equal(spawned[0].environment.type, "project-default");
    assert.equal(spawned[0].title, "T-1: Needs a project".slice(0, 80));
    assert.ok(fromContext.item.threads.some((thread) => thread.threadId === "thr-spawned-1"));
    assert.match(fromContext.item.logs[0].text, /thr-spawned-1/);

    const linked = (await runJson(harness, [
      "add",
      "Continue the work",
      "--next-step",
      "Open the tests",
    ])) as TodoItem;
    assert.equal(linked.notes, "Open the tests");
    await runJson(harness, ["link", linked.id, "--thread", "thr-related", "--note", "prior"]);
    const started = (await runJson(harness, [
      "start",
      linked.id,
      "--prompt",
      "额外：先看失败的测试",
    ])) as {
      threadId: string;
      projectId: string;
      initialPrompt: string;
      item: TodoItem;
    };
    assert.equal(started.projectId, "proj-from-thread");
    assert.equal(started.threadId, "thr-spawned-2");
    assert.equal(spawned[1].environment.type, "project-default");
    assert.match(spawned[1].prompt, /@thread:thr-related/);
    assert.match(spawned[1].prompt, /最近在改测试/);
    assert.match(spawned[1].prompt, /Open the tests/);
    assert.equal(/下一步：/.test(spawned[1].prompt), false);
    assert.match(spawned[1].prompt, /额外：先看失败的测试$/);
    assert.equal(started.initialPrompt, spawned[1].prompt);
    assert.ok(started.item.threads.some((thread) => thread.threadId === "thr-spawned-2"));
    assert.equal(started.item.logs[0].threadId, "thr-spawned-2");
    assert.ok(started.item.threads.some((thread) => thread.threadId === "thr-related" && thread.note === "prior"));

    const overridden = (await runJson(harness, [
      "start",
      linked.id,
      "--project",
      "proj-explicit",
    ])) as { projectId: string; threadId: string };
    assert.equal(overridden.projectId, "proj-explicit");
    assert.equal(overridden.threadId, "thr-spawned-3");
    assert.equal(spawned[2].projectId, "proj-explicit");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("lists take distinct palette colors, titles can carry #List/Section, and undo restores deletes", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    assert.deepEqual(parseTitlePrefix("#LightSpace/Hosting Station 写 demo 期方案"), {
      listName: "LightSpace",
      sectionName: "Hosting Station",
      title: "写 demo 期方案",
    });
    assert.deepEqual(parseTitlePrefix("#LightSpace 双形态上架"), {
      listName: "LightSpace",
      sectionName: "",
      title: "双形态上架",
    });
    assert.equal(parseTitlePrefix("#LightSpace"), null);
    assert.equal(parseTitlePrefix("正文 #LightSpace 不会提取"), null);

    const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
    for (const name of names) {
      await runJson(harness, ["add", `${name} 事项`, "--list", name]);
    }
    const colored = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.deepEqual(
      colored.lists.map((list) => list.color),
      [...TODO_COLORS, fallbackTodoColor("I")],
    );
    assert.deepEqual(
      colored.lists.map((list) => list.name),
      names,
    );
    const recolored = (await harness.behavior.callRpc("setListColor", {
      listName: "A",
      color: "rose",
    })) as { name: string; color: string };
    assert.equal(recolored.color, "rose");
    const afterColor = (await runJson(harness, ["color", "B", "teal"])) as { color: string };
    assert.equal(afterColor.color, "teal");

    const parsed = (await runJson(harness, [
      "add",
      "#LightSpace/Hosting Station 写 demo 期方案",
    ])) as TodoItem;
    assert.equal(parsed.title, "写 demo 期方案");
    assert.equal(parsed.listName, "LightSpace");
    assert.equal(parsed.sectionName, "Hosting Station");
    const overridden = (await runJson(harness, [
      "add",
      "#LightSpace 双形态上架",
      "--list",
      "Other",
    ])) as TodoItem;
    assert.equal(overridden.title, "双形态上架");
    assert.equal(overridden.listName, "Other");
    const plain = (await runJson(harness, ["add", "正文 #LightSpace 不会提取"])) as TodoItem;
    assert.equal(plain.listName, "");
    assert.equal(plain.title, "正文 #LightSpace 不会提取");

    const listed = (await runJson(harness, [
      "list",
      "--list",
      "LightSpace",
      "--section",
      "Hosting Station",
    ])) as { items: TodoItem[] };
    assert.deepEqual(
      listed.items.map((item) => item.id),
      [parsed.id],
    );
    const scanned = (await runJson(harness, ["scan", "--list", "Other"])) as TodoScanResult;
    assert.deepEqual(
      scanned.items.map((item) => item.id),
      [overridden.id],
    );

    const proposal = (await runJson(harness, [
      "propose",
      "预填归属",
      "--reason",
      "独立交付",
      "--list",
      "LightSpace",
      "--section",
      "生产与上架",
    ])) as TodoItem;
    assert.equal(proposal.listName, "LightSpace");
    assert.equal(proposal.sectionName, "生产与上架");
    const accepted = (await runJson(harness, [
      "triage",
      proposal.id,
      "--action",
      "accept",
      "--list",
      "LightPower",
    ])) as { item: TodoItem };
    assert.equal(accepted.item.listName, "LightPower");
    assert.equal(accepted.item.sectionName, "生产与上架");

    const linked = (await runJson(harness, ["add", "可恢复的待办", "--next-step", "保留下一步"])) as TodoItem;
    assert.equal(linked.notes, "保留下一步");
    await runJson(harness, ["link", linked.id, "--thread", "thr-keep", "--note", "keep me"], {
      threadId: "thr_actor",
    });
    await runJson(harness, ["log", linked.id, "留下的日志", "--no-link"]);
    await runJson(harness, ["rm", linked.id], { threadId: "thr_actor" });
    assert.equal((await runJsonError(harness, ["show", linked.id])).error.code, "not_found");
    const openAfterDelete = (await runJson(harness, ["list", "--status", "all"])) as { items: TodoItem[] };
    assert.equal(
      openAfterDelete.items.some((item) => item.id === linked.id),
      false,
    );
    const undoneDelete = (await runJson(harness, ["undo"])) as {
      undoneRev: number;
      revision: TodoRevision;
    };
    assert.match(undoneDelete.revision.summary, new RegExp(`撤销 #${undoneDelete.undoneRev}`));
    const restored = (await runJson(harness, ["show", linked.id])) as TodoItem;
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.notes, "保留下一步");
    assert.equal(Object.hasOwn(restored, "nextStep"), false);
    assert.equal(restored.logs.some((log) => log.text === "留下的日志"), true);
    assert.equal(restored.threads.find((thread) => thread.threadId === "thr-keep")?.note, "keep me");

    await runJson(harness, ["done", linked.id, "--note", "Shipped"]);
    const completed = (await runJson(harness, ["show", linked.id])) as TodoItem;
    assert.ok(completed.completedAt);
    assert.equal(completed.logs.some((log) => log.text === "Shipped"), true);
    await runJson(harness, ["log", linked.id, "完成之后补充的日志", "--no-link"]);
    await runJson(harness, ["undo"]);
    const reopened = (await runJson(harness, ["show", linked.id])) as TodoItem;
    assert.equal(reopened.completedAt, null);
    assert.equal(reopened.logs.some((log) => log.text === "Shipped"), false);
    assert.equal(reopened.logs.some((log) => log.text === "留下的日志"), true);
    assert.equal(reopened.logs.some((log) => log.text === "完成之后补充的日志"), true);

    const target = (await runJson(harness, ["add", "合并目标", "--next-step", "keep target"])) as TodoItem;
    assert.equal(target.notes, "keep target");
    await runJson(harness, ["log", target.id, "target log", "--no-link"]);
    await runJson(harness, ["link", target.id, "--thread", "thr-target", "--note", "target note"]);
    const source = (await runJson(harness, [
      "propose",
      "合并来源",
      "--reason",
      "重复了",
      "--notes",
      "source notes",
      "--next-step",
      "source next",
    ])) as TodoItem;
    await runJson(harness, ["log", source.id, "source log", "--no-link"]);
    await runJson(harness, ["link", source.id, "--thread", "thr-source", "--note", "source note"]);
    await runJson(harness, ["triage", source.id, "--action", "merge", "--into", target.id]);
    assert.equal((await runJsonError(harness, ["show", source.id])).error.code, "not_found");
    await runJson(harness, ["log", target.id, "合并之后写的日志", "--no-link"]);
    await runJson(harness, ["link", target.id, "--thread", "thr-after-merge", "--note", "after merge"]);
    await runJson(harness, ["undo"]);
    const sourceBack = (await runJson(harness, ["show", source.id])) as TodoItem;
    const targetBack = (await runJson(harness, ["show", target.id])) as TodoItem;
    assert.equal(sourceBack.bucket, "inbox");
    assert.equal(sourceBack.notes, "source notes\n\nsource next");
    assert.equal(sourceBack.logs.some((log) => log.text === "source log"), true);
    assert.equal(sourceBack.threads.find((thread) => thread.threadId === "thr-source")?.note, "source note");
    assert.equal(targetBack.notes, "keep target");
    assert.equal(Object.hasOwn(targetBack, "nextStep"), false);
    assert.equal(targetBack.logs.some((log) => log.text === "target log"), true);
    assert.equal(targetBack.logs.some((log) => /Merged inbox proposal/.test(log.text)), false);
    assert.equal(targetBack.logs.some((log) => log.text === "source log"), false);
    assert.equal(targetBack.logs.some((log) => log.text === "合并之后写的日志"), true);
    assert.equal(targetBack.threads.find((thread) => thread.threadId === "thr-target")?.note, "target note");
    assert.equal(targetBack.threads.find((thread) => thread.threadId === "thr-after-merge")?.note, "after merge");
    assert.equal(targetBack.threads.some((thread) => thread.threadId === "thr-source"), false);

    const limited = (await runJson(harness, ["history", "--limit", "2"])) as {
      revisions: TodoRevision[];
    };
    assert.equal(limited.revisions.length, 2);
    const history = (await runJson(harness, ["history", "--limit", "100"])) as {
      revisions: TodoRevision[];
    };
    assert.equal(
      history.revisions.some((revision) => revision.actor === "agent:thr_actor"),
      true,
    );
    const panelCreated = (await harness.behavior.callRpc("quickAdd", { title: "面板新增" })) as TodoItem;
    const panelHistory = (await harness.behavior.callRpc("listRevisions", {})) as {
      revisions: TodoRevision[];
    };
    assert.equal(panelHistory.revisions[0]?.actor, "ui");
    assert.equal(panelHistory.revisions[0]?.itemId, panelCreated.id);
    assert.equal(
      (await runJsonError(harness, ["undo", String(undoneDelete.undoneRev)])).error.code,
      "already_undone",
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("undoing an update keeps logs and thread links written afterwards", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const created = (await runJson(harness, ["add", "初始标题"])) as TodoItem;
    const updated = (await runJson(harness, [
      "update",
      created.id,
      "--title",
      "改后标题",
    ])) as TodoItem;
    assert.equal(updated.title, "改后标题");

    await runJson(harness, ["log", created.id, "update 之后写的日志", "--no-link"]);
    await runJson(harness, ["link", created.id, "--thread", "thr-after-update", "--note", "after"]);
    const undone = (await runJson(harness, ["undo"])) as { undoneRev: number };
    assert.equal(undone.undoneRev, 2);

    const restored = (await runJson(harness, ["show", created.id])) as TodoItem;
    assert.equal(restored.title, "初始标题");
    assert.equal(restored.logs.some((log) => log.text === "update 之后写的日志"), true);
    assert.equal(
      restored.threads.find((thread) => thread.threadId === "thr-after-update")?.note,
      "after",
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("out-of-order undo returns history_stale; newest-first undo succeeds", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const created = (await runJson(harness, ["add", "标题零"])) as TodoItem;
    await runJson(harness, ["update", created.id, "--title", "标题一"]);
    await runJson(harness, ["update", created.id, "--title", "标题二"]);

    const history = (await runJson(harness, ["history"])) as { revisions: TodoRevision[] };
    const updates = history.revisions
      .filter((revision) => revision.action === "update")
      .sort((left, right) => left.rev - right.rev);
    const older = updates[0];
    const newer = updates[1];
    assert.ok(older);
    assert.ok(newer);

    const stale = await runJsonError(harness, ["undo", String(older.rev)]);
    assert.equal(stale.error.code, "history_stale");
    assert.match(stale.error.message, new RegExp(`#${newer.rev}`));
    assert.equal(((await runJson(harness, ["show", created.id])) as TodoItem).title, "标题二");

    const undoneNewest = (await runJson(harness, ["undo", String(newer.rev)])) as {
      undoneRev: number;
    };
    assert.equal(undoneNewest.undoneRev, newer.rev);
    assert.equal(((await runJson(harness, ["show", created.id])) as TodoItem).title, "标题一");

    const undoneOlder = (await runJson(harness, ["undo", String(older.rev)])) as {
      undoneRev: number;
    };
    assert.equal(undoneOlder.undoneRev, older.rev);
    assert.equal(((await runJson(harness, ["show", created.id])) as TodoItem).title, "标题零");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("suggestions dedupe, apply through revisions, and undo restores the todo", async () => {
  const { bb, harness } = fixture();
  const previousThread = process.env.BB_THREAD_ID;
  try {
    await plugin(bb);
    const item = (await runJson(harness, [
      "add",
      "Ship the checklist",
      "--bucket",
      "later",
      "--notes",
      "Original notes",
    ])) as TodoItem;

    const missingChange = await runJsonError(harness, ["suggest", item.id, "--reason", "nothing to do"]);
    assert.equal(missingChange.error.code, "empty_suggestion");
    const combined = await runJsonError(harness, [
      "suggest",
      item.id,
      "--done",
      "--bucket",
      "focus",
      "--reason",
      "both",
    ]);
    assert.equal(combined.error.code, "invalid_combination");
    const unchanged = await runJsonError(harness, [
      "suggest",
      item.id,
      "--bucket",
      "later",
      "--reason",
      "already there",
    ]);
    assert.equal(unchanged.error.code, "empty_patch");

    process.env.BB_THREAD_ID = "thr-env";
    const firstComplete = (await runJson(harness, [
      "suggest",
      "1",
      "--done",
      "--reason",
      "first reason",
    ])) as {
      id: string;
      kind: string;
      evidenceThreads: { threadId: string }[];
    };
    assert.equal(firstComplete.id, "S-1");
    assert.equal(firstComplete.kind, "complete");
    assert.deepEqual(
      firstComplete.evidenceThreads.map((thread) => thread.threadId),
      ["thr-env"],
    );

    const mergedComplete = (await runJson(
      harness,
      ["suggest", "t-1", "--done", "--reason", "merged reason", "--thread", "thr-running", "--no-link"],
      { threadId: "thr-other" },
    )) as {
      id: string;
      seq: number;
      reason: string;
      evidenceThreads: { threadId: string; threadTitle: string | null; threadStatus: string | null }[];
    };
    assert.equal(mergedComplete.id, "S-1");
    assert.equal(mergedComplete.seq, 1);
    assert.equal(mergedComplete.reason, "merged reason");
    assert.equal(mergedComplete.evidenceThreads.length, 1);
    assert.equal(mergedComplete.evidenceThreads[0]?.threadId, "thr-running");
    assert.equal(mergedComplete.evidenceThreads[0]?.threadTitle, "Thread thr-running");
    assert.equal(mergedComplete.evidenceThreads[0]?.threadStatus, "active");

    const update = (await harness.behavior.callRpc("suggest", {
      id: item.id,
      reason: "近期会话已经在推进",
      kind: "update",
      patch: {
        bucket: "focus",
        listName: "LightSpace",
        sectionName: "生产与上架",
        notesAppend: "新进展",
        title: item.title,
      },
      evidenceThreadIds: ["thr-running", "thr-running", "thr-extra"],
    })) as {
      id: string;
      kind: string;
      patch: { bucket?: string; title?: string; listName?: string; notesAppend?: string };
      evidenceThreads: { threadId: string }[];
    };
    assert.equal(update.id, "S-2");
    assert.equal(update.kind, "update");
    assert.equal(update.patch.title, undefined);
    assert.equal(update.patch.bucket, "focus");
    assert.equal(update.patch.listName, "LightSpace");
    assert.equal(update.patch.notesAppend, "新进展");
    assert.deepEqual(
      update.evidenceThreads.map((thread) => thread.threadId),
      ["thr-running", "thr-extra"],
    );

    const queued = (await runJson(harness, ["suggestions"])) as {
      suggestions: { id: string }[];
      inbox: { id: string }[];
    };
    assert.deepEqual(
      queued.suggestions.map((suggestion) => suggestion.id),
      ["S-2", "S-1"],
    );
    const proposal = (await runJson(harness, [
      "propose",
      "A separate deliverable",
      "--reason",
      "Not part of the checklist",
    ])) as TodoItem;
    const withInbox = (await runJson(harness, ["suggestions"])) as {
      suggestions: { id: string }[];
      inbox: { id: string }[];
    };
    assert.deepEqual(
      withInbox.inbox.map((entry) => entry.id),
      [proposal.id],
    );

    const snapshot = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.equal(snapshot.counts.suggestions, 2);
    assert.equal(snapshot.suggestions.length, 2);

    const acceptedUpdate = (await harness.behavior.callRpc("resolveSuggestion", {
      id: "s-2",
      decision: "accept",
    })) as { id: string; decision: string; item: TodoItem };
    assert.equal(acceptedUpdate.decision, "accept");
    assert.equal(acceptedUpdate.item.bucket, "focus");
    assert.equal(acceptedUpdate.item.listName, "LightSpace");
    assert.equal(acceptedUpdate.item.sectionName, "生产与上架");
    assert.match(acceptedUpdate.item.notes, /新进展/);
    assert.equal(
      acceptedUpdate.item.logs.some((log) => log.text.includes("later → focus")),
      true,
    );
    assert.deepEqual(
      acceptedUpdate.item.threads.map((thread) => thread.threadId).sort(),
      ["thr-extra", "thr-running"],
    );
    const history = (await harness.behavior.callRpc("listRevisions", {})) as {
      revisions: TodoRevision[];
    };
    const acceptRevision = history.revisions.find((revision) => revision.action === "suggestion_accept");
    assert.ok(acceptRevision);
    assert.match(acceptRevision.summary, /采纳建议 S-2/);

    const undone = (await harness.behavior.callRpc("undoRevision", { rev: acceptRevision.rev })) as {
      undoneRev: number;
    };
    assert.equal(undone.undoneRev, acceptRevision.rev);
    const restored = (await runJson(harness, ["show", item.id])) as TodoItem;
    assert.equal(restored.bucket, "later");
    assert.equal(restored.listName, "");
    assert.equal(restored.notes, "Original notes");
    assert.equal(restored.threads.length, 0);
    assert.equal(restored.logs.some((log) => log.text.includes("采纳建议")), false);
    const afterUndo = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.equal(
      afterUndo.suggestions.some((suggestion) => suggestion.id === "S-2" && suggestion.status === "pending"),
      true,
    );

    const acceptedComplete = (await runJson(harness, ["decide", "S-1", "--accept"])) as {
      decision: string;
      item: TodoItem;
    };
    assert.equal(acceptedComplete.decision, "accept");
    assert.equal(acceptedComplete.item.completedAt !== null, true);
    assert.equal(
      acceptedComplete.item.logs.some((log) => log.text === "采纳建议：标记完成"),
      true,
    );
    assert.equal(
      acceptedComplete.item.threads.some((thread) => thread.threadId === "thr-running"),
      true,
    );
    const completeRevision = (
      (await harness.behavior.callRpc("listRevisions", {})) as { revisions: TodoRevision[] }
    ).revisions.find((revision) => revision.summary.includes("采纳建议 S-1"));
    assert.ok(completeRevision);
    await harness.behavior.callRpc("undoRevision", { rev: completeRevision.rev });
    const reopened = (await runJson(harness, ["show", item.id])) as TodoItem;
    assert.equal(reopened.completedAt, null);
    assert.equal(reopened.logs.some((log) => log.text === "采纳建议：标记完成"), false);
    assert.equal(reopened.threads.some((thread) => thread.threadId === "thr-running"), false);

    const dismissed = (await runJson(harness, ["decide", "1", "--dismiss"])) as {
      id: string;
      decision: string;
      item: TodoItem | null;
    };
    assert.equal(dismissed.id, "S-1");
    assert.equal(dismissed.decision, "dismiss");
    assert.equal(dismissed.item, null);
    const afterDismiss = (await runJson(harness, ["show", item.id])) as TodoItem;
    assert.equal(afterDismiss.bucket, "later");
    assert.equal(afterDismiss.completedAt, null);
    assert.equal(afterDismiss.title, item.title);

    const lingering = (await harness.behavior.callRpc("suggest", {
      id: item.id,
      reason: "maybe done",
      kind: "complete",
      patch: { completionNote: "checked by hand" },
      evidenceThreadIds: [],
    })) as { id: string };
    const keptUpdate = (await harness.behavior.callRpc("suggest", {
      id: item.id,
      reason: "rename after the check",
      kind: "update",
      patch: { title: "Ship the renamed checklist" },
    })) as { id: string };
    await runJson(harness, ["done", item.id, "--note", "manual"]);
    const afterManual = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.equal(
      afterManual.suggestions.some((suggestion) => suggestion.id === lingering.id),
      false,
    );
    assert.equal(
      afterManual.suggestions.some((suggestion) => suggestion.id === keptUpdate.id),
      true,
    );

    await runJson(harness, ["rm", item.id]);
    const afterRemove = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.equal(afterRemove.suggestions.length, 0);
    assert.equal(afterRemove.counts.suggestions, 0);
  } finally {
    if (previousThread === undefined) delete process.env.BB_THREAD_ID;
    else process.env.BB_THREAD_ID = previousThread;
    await harness.lifecycle.dispose();
  }
});

test("quickAdd afterId inserts immediately after target row and rebalances ties", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const first = (await harness.behavior.callRpc("quickAdd", {
      title: "First",
      bucket: "focus",
    })) as TodoItem;
    const second = (await harness.behavior.callRpc("quickAdd", {
      title: "Second",
      bucket: "focus",
    })) as TodoItem;
    const third = (await harness.behavior.callRpc("quickAdd", {
      title: "Third",
      bucket: "focus",
    })) as TodoItem;

    const mid1 = (await harness.behavior.callRpc("quickAdd", {
      title: "After First",
      bucket: "focus",
      afterId: first.id,
    })) as TodoItem;
    const mid2 = (await harness.behavior.callRpc("quickAdd", {
      title: "After Mid1",
      bucket: "focus",
      afterId: mid1.id,
    })) as TodoItem;
    const tail = (await harness.behavior.callRpc("quickAdd", {
      title: "At Bottom",
      bucket: "focus",
      afterId: third.id,
    })) as TodoItem;

    const snapshot = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.deepEqual(
      snapshot.buckets.focus.map((item) => item.id),
      [first.id, mid1.id, mid2.id, second.id, third.id, tail.id],
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("reorder places a block before another row and undo restores it", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const first = (await harness.behavior.callRpc("quickAdd", { title: "First", bucket: "focus" })) as TodoItem;
    const second = (await harness.behavior.callRpc("quickAdd", {
      title: "Second",
      bucket: "focus",
      listName: "LightSpace",
      sectionName: "上架",
    })) as TodoItem;
    const third = (await harness.behavior.callRpc("quickAdd", { title: "Third", bucket: "focus" })) as TodoItem;

    const already = (await harness.behavior.callRpc("reorder", {
      ids: [first.id],
      beforeId: second.id,
    })) as { changed: boolean };
    assert.equal(already.changed, false);

    const moved = (await harness.behavior.callRpc("reorder", {
      ids: [third.id, second.id],
      beforeId: first.id,
    })) as { changed: boolean };
    assert.equal(moved.changed, true);
    const reordered = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.deepEqual(
      reordered.buckets.focus.map((item) => item.id),
      [third.id, second.id, first.id],
    );
    assert.equal(reordered.buckets.focus.find((item) => item.id === second.id)?.listName, "LightSpace");

    const filed = (await harness.behavior.callRpc("reorder", {
      ids: [third.id],
      beforeId: second.id,
      listName: "LightSpace",
      sectionName: "上架",
    })) as { changed: boolean; items: TodoItem[] };
    assert.equal(filed.changed, true);
    assert.equal(filed.items[0]?.sectionName, "上架");
    const grouped = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    const sectionOrder = grouped.buckets.focus
      .filter((item) => item.sectionName === "上架")
      .map((item) => item.id);
    assert.deepEqual(sectionOrder, [third.id, second.id]);

    await harness.behavior.callRpc("undoRevision", {});
    const restored = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.equal(restored.buckets.focus.find((item) => item.id === third.id)?.sectionName, "");
    assert.deepEqual(
      restored.buckets.focus.map((item) => item.id),
      [third.id, second.id, first.id],
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("tied sort orders stay reversible, and an empty group appends after its list", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const first = (await harness.behavior.callRpc("quickAdd", {
      title: "A",
      bucket: "focus",
      listName: "LightSpace",
    })) as TodoItem;
    const second = (await harness.behavior.callRpc("quickAdd", {
      title: "B",
      bucket: "focus",
      listName: "Other",
    })) as TodoItem;
    const third = (await harness.behavior.callRpc("quickAdd", {
      title: "C",
      bucket: "focus",
    })) as TodoItem;
    for (const item of [first, second, third]) {
      await harness.behavior.callRpc("update", { id: item.id, sortOrder: 0 });
    }

    await harness.behavior.callRpc("reorder", { ids: [third.id], beforeId: second.id });
    const moved = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.deepEqual(
      moved.buckets.focus.map((item) => item.id),
      [first.id, third.id, second.id],
    );
    await harness.behavior.callRpc("undoRevision", {});
    const restored = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.deepEqual(
      restored.buckets.focus.map((item) => item.id),
      [first.id, second.id, third.id],
    );

    await runJson(harness, ["move", third.id, "--list", "Other", "--section", "新"]);
    const appended = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.deepEqual(
      appended.buckets.focus.map((item) => item.id),
      [first.id, second.id, third.id],
    );
    const placed = appended.buckets.focus.find((item) => item.id === third.id);
    assert.equal(placed?.listName, "Other");
    assert.equal(placed?.sectionName, "新");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("batch complete, move, and delete are each one undoable change", async () => {
  const { bb, harness } = fixture();
  try {
    await plugin(bb);
    const keep = (await harness.behavior.callRpc("quickAdd", {
      title: "Keep",
      bucket: "later",
      listName: "Alpha",
    })) as TodoItem;
    const first = (await harness.behavior.callRpc("quickAdd", {
      title: "First",
      bucket: "focus",
      listName: "Alpha",
    })) as TodoItem;
    const second = (await harness.behavior.callRpc("quickAdd", {
      title: "Second",
      bucket: "focus",
      listName: "Beta",
    })) as TodoItem;

    const moved = (await runJson(harness, [
      "batch",
      "move",
      first.id,
      second.id,
      "--bucket",
      "later",
    ])) as { changed: boolean; ids: string[] };
    assert.equal(moved.changed, true);
    assert.deepEqual(moved.ids, [first.id, second.id]);
    const afterMove = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.deepEqual(
      afterMove.buckets.later.map((item) => item.id),
      [keep.id, first.id, second.id],
    );
    assert.equal(afterMove.buckets.later.find((item) => item.id === second.id)?.listName, "Beta");

    const samePlace = (await runJson(harness, [
      "batch",
      "move",
      first.id,
      "--bucket",
      "later",
    ])) as { changed: boolean };
    assert.equal(samePlace.changed, false);

    await runJson(harness, ["batch", "complete", first.id, second.id]);
    const completed = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.deepEqual(
      completed.done.map((item) => item.id).sort(),
      [first.id, second.id].sort(),
    );
    const history = (await runJson(harness, ["history", "--limit", "5"])) as {
      revisions: Array<{ summary: string; undoneAt: string | null }>;
    };
    assert.equal(history.revisions.filter((revision) => revision.undoneAt === null).length >= 2, true);
    await runJson(harness, ["undo"]);
    const reopened = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.deepEqual(
      reopened.buckets.later.map((item) => item.id),
      [keep.id, first.id, second.id],
    );

    await runJson(harness, ["batch", "delete", first.id, second.id]);
    const deleted = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.deepEqual(deleted.buckets.later.map((item) => item.id), [keep.id]);
    await runJson(harness, ["undo"]);
    const returned = (await harness.behavior.callRpc("listSnapshot", {})) as TodoSnapshot;
    assert.deepEqual(
      returned.buckets.later.map((item) => item.id),
      [keep.id, first.id, second.id],
    );

    const rejected = await runJsonError(harness, ["batch", "move", keep.id]);
    assert.equal(rejected.error.code, "invalid_input");
    const missing = await runJsonError(harness, ["move", "T-99", "--before", keep.id]);
    assert.equal(missing.error.code, "not_found");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("package imports only public SDK surfaces", async () => {
  const result = await experimental_scanPublicSdkOnly(process.cwd(), {
    // Frontend test-only tooling; production code keeps the server surface free
    // of these imports.
    allow: [/^react$/, /^zod$/, /^jsdom$/, /^@testing-library\/react$/],
  });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.privateDependencies, []);
});
