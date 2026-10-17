import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeThreadResponse,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { groupBookmarks, bookmarkSchema } from "./contract";

function fixture(fallbackTitles = false) {
  return createFakePluginHost({
    pluginId: "bookmarks",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: threadId === "t2" ? "p2" : "p1",
            title: fallbackTitles ? null : `会话 ${threadId}`,
            titleFallback: fallbackTitles ? `Automatic title ${threadId}` : "Fallback must not replace an explicit title",
          }),
      },
      projects: {
        get: async ({ projectId }) => ({
          id: projectId,
          name: `项目 ${projectId}`,
          order: 0,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }),
      },
    },
  });
}

test("保存精确文字与来源，重载后可搜索、分组、修改和删除", async () => {
  let { bb, harness } = fixture();
  try {
    await plugin(bb);
    const add = async (threadId: string, text: string) =>
      bookmarkSchema.parse(
        await harness.behavior.callRpc("add", { threadId, text, messageSeq: 7 }),
      );
    const first = await add("t1", "选区 100%_原样\n第二行");
    const second = await add("t2", "另一项目整条消息");
    await add("t1", "普通消息");
    assert.equal(first.text, "选区 100%_原样\n第二行");
    assert.equal(first.messageSeq, 7);
    assert.equal(first.projectId, "p1");
    assert.equal(first.threadTitle, "会话 t1");
    assert.ok(Date.parse(first.createdAt));
    await harness.behavior.callRpc("note", { id: first.id, note: "下次查找" });
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    const list = async (input = {}) => {
      const result = await harness.behavior.callRpc("list", input);
      return result as { bookmarks: ReturnType<typeof bookmarkSchema.parse>[]; total: number };
    };
    assert.equal((await list({ query: "100%_" })).total, 1);
    assert.equal((await list({ query: "下次查找" })).bookmarks[0].note, "下次查找");
    assert.equal((await list({ query: "会话 t2" })).bookmarks[0].id, second.id);
    const page = await list({ projectId: "p1", limit: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.bookmarks.length, 1);
    const next = await list({ projectId: "p1", limit: 1, offset: 1 });
    assert.notEqual(page.bookmarks[0].id, next.bookmarks[0].id);
    const groups = groupBookmarks((await list()).bookmarks, "t1", true);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((group) => [group.id, group.bookmarks.length]).sort(), [
      ["p1", 2],
      ["p2", 1],
    ]);
    const shown = await harness.behavior.runCli(["show", first.id, "--json"]);
    assert.equal(JSON.parse(shown.stdout!).text, first.text);
    const filtered = await harness.behavior.runCli(["list", "--project", "p2", "--json"]);
    assert.deepEqual(
      JSON.parse(filtered.stdout!).bookmarks.map((item: { id: string }) => item.id),
      [second.id],
    );
    assert.equal((await harness.behavior.runCli(["rm", first.id, "--json"])).exitCode, 0);
    assert.equal((await list({ query: "100%_" })).total, 0);
    assert.equal((await harness.behavior.runCli(["show", first.id, "--json"])).exitCode, 1);
    assert.equal((await harness.behavior.runCli(["list", "--project", "--json"])).exitCode, 1);
    assert.equal((await harness.behavior.runCli(["list", "--limit", "0", "--json"])).exitCode, 1);
    await assert.rejects(
      harness.behavior.callRpc("add", { threadId: "t1", messageSeq: 0, text: "bad" }),
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("包不依赖私有 BB API", async () => {
  const result = await experimental_scanPublicSdkOnly(process.cwd(), {
    allow: [/^react$/, /^sonner$/, /^jsdom$/, /^@testing-library\/react$/],
  });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.privateDependencies, []);
});


test("language setting validates overrides, persists on reload, and CLI errors stay English", async () => {
  let { bb, harness } = fixture();
  try {
    await plugin(bb);
    for (const language of ["en", "zh-CN", "auto"]) {
      await harness.behavior.setSettings({ language });
      const missing = await harness.behavior.runCli(["show", "missing", "--json"]);
      assert.equal(JSON.parse(missing.stderr!).error, "Bookmark not found: missing");
      const duplicate = await harness.behavior.runCli(["list", "--limit", "1", "--limit", "2", "--json"]);
      assert.equal(JSON.parse(duplicate.stderr!).error, "Duplicate argument: --limit");
    }
    await assert.rejects(harness.behavior.setSettings({ language: "fr" }));
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    assert.equal((await harness.behavior.runCli(["show", "missing"])).stderr, "Bookmark not found: missing");
  } finally { await harness.lifecycle.dispose(); }
});


test("bookmarks use automatic thread titles and recover legacy untitled snapshots on reads", async () => {
  const { bb, harness } = fixture(true);
  try {
    await plugin(bb);
    const added = bookmarkSchema.parse(await harness.behavior.callRpc("add", {
      threadId: "t1", messageSeq: 7, text: "Title fallback regression",
    }));
    assert.equal(added.threadTitle, "Automatic title t1");
    const db = bb.storage.database();
    for (const placeholder of ["未命名会话", ""]) {
      db.prepare("UPDATE bookmarks SET threadTitle = ? WHERE id = ?").run(placeholder, added.id);
      const listed = await harness.behavior.callRpc("list", {}) as { bookmarks: typeof added[] };
      assert.equal(listed.bookmarks[0].threadTitle, "Automatic title t1");
      const searched = await harness.behavior.callRpc("list", { query: "Automatic title t1" }) as { total: number };
      assert.equal(searched.total, 1);
      db.prepare("UPDATE bookmarks SET threadTitle = ? WHERE id = ?").run(placeholder, added.id);
      const cli = await harness.behavior.runCli(["show", added.id, "--json"]);
      assert.equal(JSON.parse(cli.stdout!).threadTitle, "Automatic title t1");
      assert.equal((db.prepare("SELECT threadTitle FROM bookmarks WHERE id = ?").get(added.id) as { threadTitle: string }).threadTitle, "Automatic title t1");
    }
    db.prepare("UPDATE bookmarks SET threadTitle = ? WHERE id = ?").run("Saved title", added.id);
    const cli = await harness.behavior.runCli(["list", "--json"]);
    assert.equal(JSON.parse(cli.stdout!).bookmarks[0].threadTitle, "Saved title");
    db.prepare("UPDATE bookmarks SET threadTitle = ? WHERE id = ?").run("未命名会话", added.id);
    harness.sdk.stub("threads.get", async () => { throw new Error("Thread deleted"); });
    const unavailable = await harness.behavior.callRpc("list", {}) as { bookmarks: typeof added[] };
    assert.equal(unavailable.bookmarks[0].text, "Title fallback regression");
    assert.equal(unavailable.bookmarks[0].threadTitle, "");
    const shown = await harness.behavior.runCli(["show", added.id, "--json"]);
    assert.equal(JSON.parse(shown.stdout!).text, "Title fallback regression");
  } finally { await harness.lifecycle.dispose(); }
});
