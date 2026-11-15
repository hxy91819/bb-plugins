import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { JSDOM } from "jsdom";
import {
  TODO_CHANGED_EVENT,
  TODO_COLORS,
  rpcContract,
  type TodoColor,
  type TodoCounts,
  type TodoFormalBucket,
  type TodoItem,
  type TodoListSummary,
  type TodoRevision,
  type TodoSnapshot,
  type TodoSuggestion,
} from "./contract";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
const keys = ["window", "document", "HTMLElement", "MutationObserver", "navigator"] as const;
const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { default: app } = await import("./app");
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

beforeEach(() => {
  dom.window.localStorage.clear();
});

const createdAt = "2026-11-13T10:00:00.000Z";

function makeItem(seq: number, overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: `T-${seq}`,
    seq,
    title: `待办 ${seq}`,
    bucket: "focus",
    notes: "",
    proposalReason: null,
    listName: "",
    sectionName: "",
    completedAt: null,
    deletedAt: null,
    sortOrder: 0,
    createdAt,
    updatedAt: createdAt,
    threads: [],
    logs: [],
    ...overrides,
  };
}

class Store {
  nextSeq = 1;
  items: TodoItem[] = [];
  failSnapshot = false;
  colors = new Map<string, TodoColor>();
  revisions: TodoRevision[] = [];
  suggestions: TodoSuggestion[] = [];

  add(overrides: Partial<TodoItem> = {}): TodoItem {
    const item = makeItem(this.nextSeq++, overrides);
    this.items.push(item);
    return item;
  }

  find(id: string): TodoItem {
    const item = this.items.find((candidate) => candidate.id === id);
    assert.ok(item, `missing fixture ${id}`);
    return item;
  }

  snapshot(): TodoSnapshot {
    const active = this.items.filter((item) => item.completedAt === null);
    const formal = active.filter((item) => item.bucket !== "inbox");
    const bucket = (name: TodoFormalBucket) =>
      formal.filter((item) => item.bucket === name).sort((a, b) => a.sortOrder - b.sortOrder || a.seq - b.seq);
    const pendingSuggestions = this.suggestions.filter((suggestion) => suggestion.status === "pending");
    const counts: TodoCounts = {
      inbox: active.filter((item) => item.bucket === "inbox").length,
      focus: bucket("focus").length,
      later: bucket("later").length,
      waiting: bucket("waiting").length,
      open: formal.length,
      done: this.items.filter((item) => item.completedAt !== null).length,
      suggestions: pendingSuggestions.length,
    };
    const lists = new Map<string, TodoListSummary>();
    for (const item of formal) {
      if (!item.listName) continue;
      const current = lists.get(item.listName) ?? {
        name: item.listName,
        color: this.colors.get(item.listName) ?? TODO_COLORS[lists.size % TODO_COLORS.length] ?? "blue",
        openCount: 0,
        sections: [],
      };
      current.openCount += 1;
      if (item.sectionName && !current.sections.includes(item.sectionName)) {
        current.sections.push(item.sectionName);
      }
      lists.set(item.listName, current);
    }
    return {
      buckets: {
        focus: bucket("focus"),
        later: bucket("later"),
        waiting: bucket("waiting"),
        inbox: active
          .filter((item) => item.bucket === "inbox")
          .sort((a, b) => b.seq - a.seq),
      },
      done: this.items
        .filter((item) => item.completedAt === null ? false : item.deletedAt === null)
        .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))
        .slice(0, 20),
      counts,
      suggestions: pendingSuggestions,
      lists: [...lists.values()],
    };
  }
}

function handlers(store: Store) {
  const touch = (item: TodoItem) => {
    item.updatedAt = new Date(Date.parse(item.updatedAt) + 1000).toISOString();
    return item;
  };
  return {
    listSnapshot: () => {
      if (store.failSnapshot) throw new Error("snapshot unavailable");
      return store.snapshot();
    },
    quickAdd: (input: { title: string; bucket?: TodoFormalBucket; listName?: string; sectionName?: string }) =>
      store.add({
        title: input.title,
        bucket: input.bucket ?? "focus",
        listName: input.listName ?? "",
        sectionName: input.sectionName ?? "",
      }),
    update: (input: {
      id: string;
      title?: string;
      bucket?: TodoFormalBucket;
      notes?: string;
      listName?: string;
      sectionName?: string;
    }) => {
      const item = store.find(input.id);
      if (input.title !== undefined) item.title = input.title;
      if (input.bucket !== undefined) item.bucket = input.bucket;
      if (input.notes !== undefined) item.notes = input.notes;
      if (input.listName !== undefined) item.listName = input.listName;
      if (input.sectionName !== undefined) item.sectionName = input.sectionName;
      return touch(item);
    },
    setCompleted: (input: { id: string; completed: boolean }) => {
      const item = store.find(input.id);
      item.completedAt = input.completed ? "2026-11-13T12:00:00.000Z" : null;
      return touch(item);
    },
    triageInbox: (input: {
      id: string;
      action: "accept" | "merge" | "dismiss";
      bucket?: TodoFormalBucket;
      intoId?: string;
    }) => {
      const item = store.find(input.id);
      if (input.action === "dismiss") {
        store.items = store.items.filter((candidate) => candidate.id !== item.id);
        return { action: "dismiss" as const, item: null };
      }
      if (input.action === "accept") {
        item.bucket = input.bucket ?? "focus";
        item.proposalReason = null;
        return { action: "accept" as const, item: touch(item) };
      }
      assert.ok(input.intoId, "merge wants a target");
      const target = store.find(input.intoId);
      target.logs = [
        { id: 99, text: `Merged: ${item.title}`, threadId: null, createdAt },
        ...target.logs,
      ];
      store.items = store.items.filter((candidate) => candidate.id !== item.id);
      return { action: "merge" as const, item: touch(target) };
    },
    addLog: () => {
      throw new Error("unused in frontend tests");
    },
    linkThread: () => {
      throw new Error("unused in frontend tests");
    },
    unlinkThread: () => {
      throw new Error("unused in frontend tests");
    },
    remove: (input: { id: string }) => {
      const before = store.items.length;
      store.items = store.items.filter((item) => item.id !== input.id);
      return { removed: store.items.length !== before };
    },
    setListColor: (input: { listName: string; color: TodoColor }) => {
      store.colors.set(input.listName, input.color);
      const summary = store.snapshot().lists.find((list) => list.name === input.listName);
      return summary ?? { name: input.listName, color: input.color, openCount: 0, sections: [] };
    },
    listRevisions: () => ({ revisions: store.revisions }),
    undoRevision: (input: { rev?: number }) => {
      const target = store.revisions.find((revision) => revision.rev === input.rev);
      assert.ok(target, "missing revision");
      target.undoneAt = createdAt;
      return {
        undoneRev: target.rev,
        revision: {
          ...target,
          rev: 900,
          action: "undo" as const,
          summary: `撤销 #${target.rev}：${target.summary}`,
          undoneAt: null,
        },
      };
    },
    prepareStartSession: (input: { id: string }) => {
      const item = store.find(input.id);
      const thread = item.threads[0];
      return {
        itemId: item.id,
        title: item.title,
        projectId: thread?.projectId ?? null,
        environmentId: thread?.environmentId ?? null,
        initialPrompt: thread
          ? `推进待办 ${item.id}：${item.title}\n@thread:${thread.threadId}`
          : `推进待办 ${item.id}：${item.title}`,
        relatedThreadCount: Math.min(item.threads.length, 5),
      };
    },
    suggest: () => {
      throw new Error("unused in frontend tests");
    },
    resolveSuggestion: (input: { id: string; decision: "accept" | "dismiss" }) => {
      const suggestion = store.suggestions.find((candidate) => candidate.id === input.id);
      assert.ok(suggestion, `missing suggestion ${input.id}`);
      if (input.decision === "dismiss") {
        suggestion.status = "dismissed";
        return { id: suggestion.id, decision: "dismiss" as const, item: null };
      }
      const item = store.find(suggestion.itemId);
      if (suggestion.kind === "complete") item.completedAt = createdAt;
      if (suggestion.patch.title) item.title = suggestion.patch.title;
      if (suggestion.patch.bucket) item.bucket = suggestion.patch.bucket;
      if (suggestion.patch.listName !== undefined) item.listName = suggestion.patch.listName;
      if (suggestion.patch.sectionName !== undefined) item.sectionName = suggestion.patch.sectionName;
      if (suggestion.patch.notesAppend) {
        item.notes = item.notes.length > 0 ? `${item.notes}\n\n${suggestion.patch.notesAppend}` : suggestion.patch.notesAppend;
      }
      suggestion.status = "accepted";
      return { id: suggestion.id, decision: "accept" as const, item: touch(item) };
    },
    acceptAllSuggestions: (input: { ids?: string[] }) => {
      const accepted: { id: string; kind: "suggestion" | "inbox" }[] = [];
      for (const id of input.ids ?? []) {
        if (/^[sS]-/u.test(id)) {
          const suggestion = store.suggestions.find((candidate) => candidate.id === id);
          assert.ok(suggestion, `missing suggestion ${id}`);
          suggestion.status = "accepted";
          const item = store.find(suggestion.itemId);
          if (suggestion.kind === "complete") item.completedAt = createdAt;
          if (suggestion.patch.bucket) item.bucket = suggestion.patch.bucket;
          accepted.push({ id, kind: "suggestion" });
          continue;
        }
        const item = store.find(id);
        item.bucket = "focus";
        item.proposalReason = null;
        accepted.push({ id, kind: "inbox" });
      }
      return { accepted };
    },
  };
}

async function mountedPanel(store: Store) {
  const captured = await loadPluginApp(app);
  return renderSlot<{ subPath: string }, typeof rpcContract>(
    captured.navPanels[0],
    { subPath: "" },
    { rpc: handlers(store), experimental_rpcContract: rpcContract },
  );
}

/** Small real-timer poll for DOM and RPC transitions. Checks should throw
 * plain errors, never `assert.equal` with a DOM node. */
async function waitUntil<T>(check: () => T, timeout = 2000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

test("一行输入按 Enter 秒加；右侧分组选择器切换生效；中文输入法组合态不误提交", async () => {
  const store = new Store();
  const slot = await mountedPanel(store);
  try {
    await slot.findByText("还没有待办。");
    assert.ok(slot.queryByLabelText("Agent 建议") === null);
    const input = slot.getByRole("textbox", { name: "新待办标题" }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "安排发布" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => assert.equal(input.value, ""));
    assert.deepEqual(
      slot.inspection.rpcCalls.filter((call) => call.method === "quickAdd"),
      [{ method: "quickAdd", input: { title: "安排发布", bucket: "focus" } }],
    );
    await slot.findByText("安排发布");

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "中文输入法标题" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    assert.equal(
      slot.inspection.rpcCalls.filter((call) => call.method === "quickAdd").length,
      1,
    );
    fireEvent.compositionEnd(input);

    const bucketSelect = slot.getByLabelText("添加到分组") as HTMLSelectElement;
    assert.equal(bucketSelect.value, "focus");
    assert.ok(bucketSelect.className.includes("h-7"));
    assert.ok(bucketSelect.className.includes("border-0"));
    assert.ok(bucketSelect.className.includes("bg-muted"));
    fireEvent.change(bucketSelect, { target: { value: "later" } });
    assert.equal(bucketSelect.value, "later");
    fireEvent.change(input, { target: { value: "下周再看" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => assert.equal(input.value, ""));
    assert.deepEqual(
      slot.inspection.rpcCalls.filter((call) => call.method === "quickAdd").at(-1),
      { method: "quickAdd", input: { title: "下周再看", bucket: "later" } },
    );
    await waitUntil(() => slot.getByRole("heading", { name: "Later" }));
    assert.ok(slot.getByText("下周再看"));
  } finally {
    slot.lifecycle.unmount();
  }
});

test("圆形勾选完成待办，已完成区默认收起，展开后可一键恢复", async () => {
  const store = new Store();
  const item = store.add({ title: "写面板", notes: "先画布局" });
  const slot = await mountedPanel(store);
  try {
    await slot.findByText("写面板");
    fireEvent.click(slot.getByRole("checkbox", { name: "完成 T-1" }));
    await slot.findByRole("button", { name: /已完成/ });
    assert.deepEqual(
      slot.inspection.rpcCalls.find((call) => call.method === "setCompleted"),
      { method: "setCompleted", input: { id: item.id, completed: true } },
    );
    assert.ok(slot.queryByRole("checkbox", { name: "恢复 T-1" }) === null);

    fireEvent.click(slot.getByRole("button", { name: /已完成/ }));
    const restore = await slot.findByRole("checkbox", { name: "恢复 T-1" });
    fireEvent.click(restore);
    await slot.findByRole("checkbox", { name: "完成 T-1" });
    assert.deepEqual(
      slot.inspection.rpcCalls.filter((call) => call.method === "setCompleted").at(-1),
      { method: "setCompleted", input: { id: item.id, completed: false } },
    );
    await waitFor(() => {
      if (slot.queryByRole("button", { name: /已完成/ }) !== null) {
        throw new Error("completed section still visible");
      }
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("Inbox 提议可采纳到指定分组、并入已有项或忽略，空时整块消失", async () => {
  const store = new Store();
  store.add({ title: "已有主攻项" });
  store.add({
    title: "招设计师",
    bucket: "inbox",
    proposalReason: "会议里反复提到，需要独立产出",
    threads: [
      {
        threadId: "thr-design",
        note: "设计讨论",
        linkedAt: createdAt,
        threadTitle: "设计讨论",
        threadStatus: "active",
      },
    ],
  });
  store.add({ title: "合并提案", bucket: "inbox", proposalReason: "和已有项高度重合" });
  store.add({ title: "忽略提案", bucket: "inbox", proposalReason: "一次性寒暄" });
  store.add({ title: "直接采纳", bucket: "inbox", proposalReason: "默认落到 Focus" });
  const slot = await mountedPanel(store);
  try {
    const inbox = await waitUntil(() => slot.getByLabelText("Agent 建议"));
    assert.ok(within(inbox).getAllByText("新增待办").length >= 1);
    assert.ok(within(inbox).getByText("会议里反复提到，需要独立产出"));
    assert.ok(within(inbox).getByRole("button", { name: "打开会话 设计讨论" }));

    const acceptRow = within(inbox).getByText("招设计师").closest("li");
    assert.ok(acceptRow);
    fireEvent.click(within(acceptRow).getByRole("button", { name: "调整" }));
    fireEvent.change(within(acceptRow).getByLabelText("采纳 T-2 到分组"), {
      target: { value: "later" },
    });
    fireEvent.click(within(acceptRow).getByRole("button", { name: "采纳" }));
    await waitUntil(() =>
      assert.deepEqual(
        slot.inspection.rpcCalls.find((call) => call.method === "triageInbox"),
        { method: "triageInbox", input: { id: "T-2", action: "accept", bucket: "later" } },
      ),
    );
    await waitUntil(() => slot.getByRole("heading", { name: "Later" }));

    const defaultRow = within(await waitUntil(() => slot.getByLabelText("Agent 建议")))
      .getByText("直接采纳")
      .closest("li");
    assert.ok(defaultRow);
    fireEvent.click(within(defaultRow).getByRole("button", { name: "调整" }));
    assert.equal(
      (within(defaultRow).getByLabelText("采纳 T-5 到分组") as HTMLSelectElement).value,
      "focus",
    );
    fireEvent.click(within(defaultRow).getByRole("button", { name: "采纳" }));
    await waitUntil(() =>
      assert.deepEqual(
        slot.inspection.rpcCalls.filter((call) => call.method === "triageInbox").at(-1),
        { method: "triageInbox", input: { id: "T-5", action: "accept", bucket: "focus" } },
      ),
    );
    await waitUntil(() => slot.getByRole("heading", { name: "Focus" }));

    const inboxAgain = await waitUntil(() => slot.getByLabelText("Agent 建议"));
    const mergeRow = within(inboxAgain).getByText("合并提案").closest("li");
    assert.ok(mergeRow);
    fireEvent.click(within(mergeRow).getByRole("button", { name: "调整" }));
    fireEvent.click(within(mergeRow).getByRole("button", { name: "并入" }));
    assert.equal(
      (within(mergeRow).getByLabelText("并入目标 T-3") as HTMLSelectElement).value,
      "T-1",
    );
    assert.ok(within(mergeRow).getByRole("option", { name: "T-1 已有主攻项" }));
    fireEvent.click(within(mergeRow).getByRole("button", { name: "确认并入" }));
    await waitUntil(() =>
      assert.deepEqual(
        slot.inspection.rpcCalls.filter((call) => call.method === "triageInbox").at(-1),
        { method: "triageInbox", input: { id: "T-3", action: "merge", intoId: "T-1" } },
      ),
    );

    const dismissRow = within(await waitUntil(() => slot.getByLabelText("Agent 建议")))
      .getByText("忽略提案")
      .closest("li");
    assert.ok(dismissRow);
    fireEvent.click(within(dismissRow).getByRole("button", { name: "忽略" }));
    await waitUntil(() =>
      assert.deepEqual(
        slot.inspection.rpcCalls.filter((call) => call.method === "triageInbox").at(-1),
        { method: "triageInbox", input: { id: "T-4", action: "dismiss" } },
      ),
    );
    await waitFor(() => {
      if (slot.queryByLabelText("Agent 建议") !== null) throw new Error("inbox still visible");
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("会话胶囊与日志里的 threadId 都跳到对应 BB 会话", async () => {
  const store = new Store();
  store.add({
    title: "接上前端",
    threads: [
      {
        threadId: "thr-abc",
        note: "",
        linkedAt: createdAt,
        threadTitle: "前端实现会话",
        threadStatus: "starting",
      },
    ],
    logs: [
      {
        id: 1,
        text: "面板骨架已经落地",
        threadId: "thr-log",
        createdAt,
      },
    ],
  });
  const slot = await mountedPanel(store);
  try {
    await slot.findByText("接上前端");
    fireEvent.click(slot.getByRole("button", { name: "打开会话 前端实现会话" }));
    assert.deepEqual(slot.inspection.navigateCalls.at(-1), {
      method: "toThread",
      threadId: "thr-abc",
    });

    fireEvent.click(slot.getByRole("button", { name: "展开 T-1 详情" }));
    assert.ok(await slot.findByText("面板骨架已经落地"));
    fireEvent.click(slot.getByRole("button", { name: /打开进展会话/ }));
    assert.deepEqual(slot.inspection.navigateCalls.at(-1), {
      method: "toThread",
      threadId: "thr-log",
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("行内详情保存标题、备注与分组，并可删除条目", async () => {
  const store = new Store();
  store.add({ title: "写前端", notes: "旧备注" });
  const slot = await mountedPanel(store);
  try {
    await slot.findByText("写前端");
    fireEvent.click(slot.getByRole("button", { name: "展开 T-1 详情" }));
    assert.equal(slot.queryByLabelText("下一步 T-1"), null);
    fireEvent.change(slot.getByLabelText("标题 T-1"), { target: { value: "写清亮前端" } });
    fireEvent.change(slot.getByLabelText("分组 T-1"), { target: { value: "waiting" } });
    fireEvent.change(slot.getByLabelText("备注 T-1"), { target: { value: "保持安静" } });
    fireEvent.click(slot.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      assert.deepEqual(
        slot.inspection.rpcCalls.find((call) => call.method === "update"),
        {
          method: "update",
          input: {
            id: "T-1",
            title: "写清亮前端",
            bucket: "waiting",
            notes: "保持安静",
          },
        },
      ),
    );
    await slot.findByRole("heading", { name: "Waiting" });
    assert.ok(slot.getByText("写清亮前端"));

    fireEvent.click(slot.getByRole("button", { name: "删除 T-1" }));
    await waitFor(() => {
      if (slot.queryByText("写清亮前端") !== null) throw new Error("todo still visible");
    });
    assert.deepEqual(slot.inspection.rpcCalls.find((call) => call.method === "remove"), {
      method: "remove",
      input: { id: "T-1" },
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("导航角标优先提示 inbox，其次 focus，realtime 刷新且异常时退回 null", async () => {
  const captured = await loadPluginApp(app);
  const badgeHook = captured.navPanels[0].experimental_useBadge;
  assert.equal(typeof badgeHook, "function");
  const store = new Store();
  store.add({ title: "主攻一" });
  store.add({ title: "提议", bucket: "inbox", proposalReason: "来自纪要" });
  store.add({ title: "提议二", bucket: "inbox", proposalReason: "来自聊天" });

  function BadgeProbe() {
    const badge = badgeHook!();
    return createElement("output", { "data-testid": "badge" }, JSON.stringify(badge));
  }

  const slot = renderSlot<Record<string, never>, typeof rpcContract>(
    { component: BadgeProbe },
    {},
    { rpc: handlers(store), experimental_rpcContract: rpcContract },
  );
  const readBadge = () => JSON.parse(slot.getByTestId("badge").textContent || "null") as unknown;
  try {
    await waitFor(() =>
      assert.deepEqual(readBadge(), {
        count: 2,
        tone: "warning",
        label: "2 项 Agent 建议",
      }),
    );

    store.items = store.items.filter((item) => item.bucket !== "inbox");
    await slot.behavior.emitRealtime(TODO_CHANGED_EVENT, {});
    await waitFor(() =>
      assert.deepEqual(readBadge(), { count: 1, tone: "neutral", label: "1 项主攻待办" }),
    );

    store.failSnapshot = true;
    await slot.behavior.emitRealtime(TODO_CHANGED_EVENT, {});
    await waitFor(() => assert.equal(readBadge(), null));
  } finally {
    slot.lifecycle.unmount();
  }
});

test("未修改的详情跟上服务端字段，编辑中的草稿不被 realtime 冲掉", async () => {
  const store = new Store();
  store.add({ title: "写前端", notes: "旧备注" });
  const slot = await mountedPanel(store);
  try {
    await slot.findByText("写前端");
    fireEvent.click(slot.getByRole("button", { name: "展开 T-1 详情" }));
    const notes = () => slot.getByLabelText("备注 T-1") as HTMLTextAreaElement;
    const title = () => slot.getByLabelText("标题 T-1") as HTMLInputElement;
    assert.equal(notes().value, "旧备注");

    const item = store.find("T-1");
    item.notes = "服务端备注";
    item.updatedAt = "2026-11-13T10:00:01.000Z";
    await slot.behavior.emitRealtime(TODO_CHANGED_EVENT, {});
    await waitFor(() => {
      if (notes().value !== "服务端备注") throw new Error(notes().value);
    });

    fireEvent.change(notes(), { target: { value: "草稿备注" } });
    item.title = "服务端新标题";
    item.notes = "服务端又改了备注";
    item.updatedAt = "2026-11-13T10:00:02.000Z";
    item.logs = [{ id: 7, text: "后台写入的日志", threadId: "thr-bg", createdAt }];
    item.threads = [
      {
        threadId: "thr-bg",
        note: "",
        linkedAt: createdAt,
        threadTitle: "后台会话",
        threadStatus: "active",
      },
    ];
    await slot.behavior.emitRealtime(TODO_CHANGED_EVENT, {});
    await slot.findByText("后台写入的日志");
    const sessionButtons = await slot.findAllByRole("button", { name: "打开会话 后台会话" });
    assert.ok(sessionButtons.some((button) => button.textContent?.includes("后台会话")));
    assert.equal(notes().value, "草稿备注");
    assert.equal(title().value, "写前端");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("未完成正式待办的新会话按钮把 prepareStartSession 送进作曲栏", async () => {
  const store = new Store();
  store.add({
    title: "继续做",
    threads: [
      {
        threadId: "thr-old",
        note: "",
        linkedAt: createdAt,
        threadTitle: "旧会话",
        threadStatus: "idle",
        projectId: "proj-1",
        environmentId: "env-1",
      },
    ],
  });
  store.add({ title: "提议", bucket: "inbox", proposalReason: "来自纪要" });
  store.add({ title: "做完了", completedAt: "2026-11-13T12:00:00.000Z" });
  store.add({ title: "全新", bucket: "later" });
  const slot = await mountedPanel(store);
  try {
    await slot.findByText("继续做");
    assert.equal(slot.queryByRole("button", { name: /开启新会话.*T-2/ }), null);
    assert.equal(slot.queryByRole("button", { name: /开启新会话.*T-3/ }), null);
    const openButtons = slot.getAllByRole("button", { name: /开启新会话/ });
    assert.equal(openButtons.length, 2);
    assert.equal(
      slot.getByRole("button", { name: "开启新会话并带入 1 个关联会话上下文（T-1）" }).getAttribute("title"),
      "开启新会话并带入 1 个关联会话上下文",
    );

    fireEvent.click(slot.getByRole("button", { name: "开启新会话并带入 1 个关联会话上下文（T-1）" }));
    await waitFor(() => {
      if (slot.inspection.navigateCalls.at(-1)?.method !== "toCompose") {
        throw new Error("compose not opened");
      }
    });
    assert.deepEqual(slot.inspection.rpcCalls.find((call) => call.method === "prepareStartSession"), {
      method: "prepareStartSession",
      input: { id: "T-1" },
    });
    // The panel only prefills the composer. It must never ask the server to
    // spawn a session on the user's behalf.
    assert.deepEqual(
      slot.inspection.rpcCalls.filter((call) =>
        ["start", "spawn", "startSession", "startTodoSession"].includes(call.method),
      ),
      [],
    );
    assert.deepEqual(slot.inspection.navigateCalls.at(-1), {
      method: "toCompose",
      options: {
        focusPrompt: true,
        initialPrompt: "推进待办 T-1：继续做\n@thread:thr-old",
        projectId: "proj-1",
        environmentId: "env-1",
      },
    });

    fireEvent.click(slot.getByRole("button", { name: "展开 T-1 详情" }));
    const detailButtons = slot.getAllByRole("button", {
      name: "开启新会话并带入 1 个关联会话上下文（T-1）",
    });
    assert.equal(detailButtons.length, 2);
    fireEvent.click(detailButtons[1]);
    await waitFor(() => {
      if (slot.inspection.navigateCalls.length < 2) throw new Error("detail compose missing");
    });
    assert.equal(slot.inspection.navigateCalls.at(-1)?.method, "toCompose");

    fireEvent.click(slot.getByRole("button", { name: "为此待办开启新会话（T-4）" }));
    await waitFor(() => {
      const call = slot.inspection.navigateCalls.at(-1);
      if (call?.method !== "toCompose" || call.options?.projectId !== undefined) {
        throw new Error("plain compose missing");
      }
    });
    assert.deepEqual(slot.inspection.navigateCalls.at(-1), {
      method: "toCompose",
      options: {
        focusPrompt: true,
        initialPrompt: "推进待办 T-4：全新",
      },
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("项目列表筛选、Section 折叠，以及选中列表时 QuickAdd 继承列表", async () => {
  const store = new Store();
  store.add({
    title: "写 demo 期方案",
    listName: "LightSpace",
    sectionName: "Hosting Station",
  });
  store.add({ title: "双形态上架", listName: "LightPower" });
  store.add({ title: "还没归类" });
  const slot = await mountedPanel(store);
  try {
    await slot.findByText("写 demo 期方案");
    await waitUntil(() => slot.getByRole("heading", { name: "LightSpace" }));
    const groupToggle = slot.getByRole("button", { name: "按项目分组" });
    assert.equal(groupToggle.getAttribute("aria-pressed"), "true");
    const groupedRow = slot.getByText("写 demo 期方案").closest("[data-todo-row]");
    assert.ok(groupedRow);
    assert.equal((groupedRow as HTMLElement).textContent?.includes("T-1"), false);
    assert.equal(groupedRow.getAttribute("title"), "T-1 写 demo 期方案");
    assert.equal(within(groupedRow as HTMLElement).queryByText("LightSpace"), null);

    fireEvent.click(groupToggle);
    await waitUntil(() => {
      if (slot.queryByRole("heading", { name: "LightSpace" }) !== null) {
        throw new Error("list heading still visible");
      }
      return true;
    });
    const flatRow = slot.getByText("写 demo 期方案").closest("[data-todo-row]");
    assert.ok(flatRow);
    assert.ok(within(flatRow as HTMLElement).getByText("LightSpace"));
    fireEvent.click(slot.getByRole("button", { name: "按项目分组" }));
    await waitUntil(() => slot.getByRole("heading", { name: "LightSpace" }));

    fireEvent.click(slot.getByRole("button", { name: /LightSpace/ }));
    await waitUntil(() => {
      if (slot.queryByText("双形态上架") !== null) throw new Error("other list still visible");
      if (slot.queryByText("还没归类") !== null) throw new Error("uncategorized still visible");
      return slot.getByRole("button", { name: /Hosting Station/ });
    });

    fireEvent.click(slot.getByRole("button", { name: /Hosting Station/ }));
    await waitUntil(() => {
      if (slot.queryByText("写 demo 期方案") !== null) throw new Error("section still open");
      return true;
    });

    const input = slot.getByRole("textbox", { name: "新待办标题" });
    fireEvent.change(input, { target: { value: "跟当前列表" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      assert.deepEqual(slot.inspection.rpcCalls.find((call) => call.method === "quickAdd"), {
        method: "quickAdd",
        input: { title: "跟当前列表", bucket: "focus", listName: "LightSpace" },
      }),
    );

    fireEvent.change(input, { target: { value: "#Other 另一件事" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      assert.deepEqual(slot.inspection.rpcCalls.filter((call) => call.method === "quickAdd").at(-1), {
        method: "quickAdd",
        input: { title: "#Other 另一件事", bucket: "focus" },
      }),
    );

    fireEvent.click(slot.getByRole("button", { name: "更换 LightSpace 的颜色" }));
    fireEvent.click(slot.getByRole("option", { name: "颜色 orange" }));
    await waitFor(() =>
      assert.deepEqual(slot.inspection.rpcCalls.find((call) => call.method === "setListColor"), {
        method: "setListColor",
        input: { listName: "LightSpace", color: "orange" },
      }),
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("折叠行是干净的三段式：标题只在主列，编号留在悬停 title 与详情头", async () => {
  const store = new Store();
  const title = "把托管站的双形态上架方案整理成一份可以交给生产环境的说明";
  store.add({
    title,
    listName: "LightSpace",
    sectionName: "Hosting Station",
    threads: [
      {
        threadId: "thr-a",
        note: "",
        linkedAt: createdAt,
        threadTitle: "会话甲",
        threadStatus: "active",
      },
      {
        threadId: "thr-b",
        note: "",
        linkedAt: createdAt,
        threadTitle: "会话乙",
        threadStatus: "idle",
      },
    ],
  });
  const slot = await mountedPanel(store);
  try {
    const titleNode = await slot.findByText(title);
    assert.ok(titleNode.className.includes("min-w-0"));
    assert.ok(titleNode.className.includes("break-words"));
    assert.ok(titleNode.className.includes("font-medium"));
    assert.equal(titleNode.getAttribute("title"), `T-1 ${title}`);
    assert.equal(slot.queryByText("下一步"), null);

    const row = titleNode.closest("[data-todo-row]");
    assert.ok(row);
    const rail = row.querySelector("[data-todo-rail]");
    const main = row.querySelector("[data-todo-main]");
    assert.ok(rail);
    assert.ok(main);
    assert.ok(main.className.includes("min-w-0 flex-1"));
    assert.ok(rail.className.includes("shrink-0 items-center gap-0.5"));
    assert.equal(rail.contains(titleNode), false);
    assert.equal(main.contains(titleNode), true);
    assert.equal((row as HTMLElement).textContent?.includes("T-1"), false);
    assert.equal(row.getAttribute("title"), `T-1 ${title}`);
    assert.equal(within(row as HTMLElement).queryByRole("button", { name: "打开会话 会话甲" }), null);
    assert.ok(within(row as HTMLElement).getByRole("button", { name: "查看 2 个关联会话" }));

    const startButton = within(row as HTMLElement).getByRole("button", {
      name: "开启新会话并带入 2 个关联会话上下文（T-1）",
    });
    assert.ok(startButton.className.includes("border-0"));
    assert.ok(startButton.className.includes("bg-transparent"));
    assert.ok(startButton.className.includes("appearance-none"));

    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "展开 T-1 详情" }));
    assert.ok(await slot.findByText("T-1"));
    assert.equal(slot.queryByLabelText("下一步 T-1"), null);
    assert.ok(await slot.findByRole("button", { name: "打开会话 会话甲" }));
    assert.ok(slot.getByRole("button", { name: "打开会话 会话乙" }));

    const quickAdd = slot.getByRole("textbox", { name: "新待办标题" });
    assert.ok(quickAdd.className.includes("min-w-0"));
    assert.ok(quickAdd.className.includes("border-0"));
    assert.ok(quickAdd.className.includes("bg-transparent"));
    assert.ok(quickAdd.className.includes("text-base"));
    assert.ok(quickAdd.className.includes("sm:text-sm"));
    const quickAddRow = quickAdd.closest("div.flex-nowrap");
    assert.ok(quickAddRow);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("最近变更抽屉可以撤销一条记录", async () => {
  const store = new Store();
  store.add({ title: "会被改掉" });
  store.revisions.push({
    rev: 3,
    itemSeq: 1,
    itemId: "T-1",
    action: "delete",
    actor: "agent:thr_demo",
    summary: "删除 T-1「会被改掉」",
    undoneAt: null,
    createdAt,
  });
  const slot = await mountedPanel(store);
  try {
    fireEvent.click(await slot.findByRole("button", { name: /最近变更/ }));
    assert.ok(await slot.findByText("删除 T-1「会被改掉」"));
    assert.ok(slot.getByText(/@thread:thr_demo/));
    fireEvent.click(slot.getByRole("button", { name: "撤销 删除 T-1「会被改掉」" }));
    await waitFor(() => {
      assert.deepEqual(slot.inspection.rpcCalls.find((call) => call.method === "undoRevision"), {
        method: "undoRevision",
        input: { rev: 3 },
      });
      if (slot.queryByRole("button", { name: "撤销 删除 T-1「会被改掉」" }) !== null) {
        throw new Error("undo button still visible");
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    slot.lifecycle.unmount();
  }
});

test("折叠行标题可原地编辑：Enter 与失焦保存，Escape 取消", async () => {
  const store = new Store();
  store.add({ title: "写前端" });
  const slot = await mountedPanel(store);
  try {
    await slot.findByText("写前端");
    fireEvent.click(slot.getByText("写前端"));
    const editor = (await slot.findByLabelText("编辑标题 T-1")) as HTMLTextAreaElement;
    assert.equal(editor.value, "写前端");
    assert.equal(editor.getAttribute("rows"), "1");
    assert.ok(editor.className.includes("resize-none"));
    assert.ok(editor.className.includes("border-0"));
    assert.ok(editor.className.includes("text-base"));
    assert.ok(editor.className.includes("sm:text-sm"));
    // The click edits the row itself and does not open details.
    assert.equal(slot.queryByLabelText("标题 T-1"), null);

    fireEvent.change(editor, { target: { value: "写清亮前端" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() =>
      assert.deepEqual(slot.inspection.rpcCalls.find((call) => call.method === "update"), {
        method: "update",
        input: { id: "T-1", title: "写清亮前端" },
      }),
    );
    await slot.findByText("写清亮前端");
    assert.equal(slot.queryByLabelText("标题 T-1"), null);

    fireEvent.click(slot.getByText("写清亮前端"));
    const blurEditor = await slot.findByLabelText("编辑标题 T-1");
    fireEvent.change(blurEditor, { target: { value: "写稳定前端" } });
    fireEvent.blur(blurEditor);
    await waitFor(() =>
      assert.deepEqual(slot.inspection.rpcCalls.filter((call) => call.method === "update").at(-1), {
        method: "update",
        input: { id: "T-1", title: "写稳定前端" },
      }),
    );
    await slot.findByText("写稳定前端");

    fireEvent.click(slot.getByText("写稳定前端"));
    const cancelEditor = await slot.findByLabelText("编辑标题 T-1");
    fireEvent.change(cancelEditor, { target: { value: "不该保存" } });
    fireEvent.keyDown(cancelEditor, { key: "Escape" });
    await slot.findByText("写稳定前端");
    assert.equal(slot.queryByLabelText("编辑标题 T-1"), null);
    assert.equal(slot.inspection.rpcCalls.filter((call) => call.method === "update").length, 2);

    // Confirming an IME candidate with Enter must never save.
    fireEvent.click(slot.getByText("写稳定前端"));
    const imeEditor = await slot.findByLabelText("编辑标题 T-1");
    fireEvent.compositionStart(imeEditor);
    fireEvent.change(imeEditor, { target: { value: "输入法中的标题" } });
    fireEvent.keyDown(imeEditor, { key: "Enter", isComposing: true });
    assert.equal(slot.inspection.rpcCalls.filter((call) => call.method === "update").length, 2);
    fireEvent.compositionEnd(imeEditor);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("项目列表筛选在卸载重挂后保持，列表消失时回退全部", async () => {
  const store = new Store();
  store.add({ title: "写 demo 期方案", listName: "LightSpace" });
  store.add({ title: "双形态上架", listName: "LightPower" });
  store.add({ title: "还没归类" });
  const first = await mountedPanel(store);
  try {
    await first.findByText("写 demo 期方案");
    fireEvent.click(first.getByRole("button", { name: /LightSpace/ }));
    await waitUntil(() => {
      if (first.queryByText("双形态上架") !== null) throw new Error("filter not applied");
      return true;
    });
  } finally {
    first.lifecycle.unmount();
  }

  const second = await mountedPanel(store);
  try {
    await second.findByText("写 demo 期方案");
    await waitUntil(() => {
      const active = second
        .getAllByRole("button")
        .find((button) => button.hasAttribute("aria-pressed") && button.textContent?.includes("LightSpace"));
      if (!active || active.getAttribute("aria-pressed") !== "true") {
        throw new Error("filter not restored");
      }
      if (second.queryByText("双形态上架") !== null) throw new Error("other list leaked");
      return true;
    });

    // The persisted list no longer exists in lists or done → fall back to all.
    store.find("T-1").listName = "LightPower";
    await second.behavior.emitRealtime(TODO_CHANGED_EVENT, {});
    await waitUntil(() => {
      const all = second
        .getAllByRole("button")
        .find((button) => button.hasAttribute("aria-pressed") && button.textContent?.includes("全部"));
      if (!all || all.getAttribute("aria-pressed") !== "true") {
        throw new Error("filter not healed");
      }
      const staleCapsule = second
        .getAllByRole("button")
        .some((button) => button.hasAttribute("aria-pressed") && button.textContent?.includes("LightSpace"));
      if (staleCapsule) throw new Error("stale list capsule still visible");
      return second.getByText("双形态上架");
    });
  } finally {
    second.lifecycle.unmount();
  }
});

test("展开中的未修改详情跟随行内标题保存", async () => {
  const store = new Store();
  store.add({ title: "旧标题", notes: "旧备注" });
  const slot = await mountedPanel(store);
  try {
    await slot.findByText("旧标题");
    fireEvent.click(slot.getByRole("button", { name: "展开 T-1 详情" }));
    const detailTitle = () => slot.getByLabelText("标题 T-1") as HTMLInputElement;
    await slot.findByLabelText("标题 T-1");

    fireEvent.click(slot.getByText("旧标题"));
    const editor = await slot.findByLabelText("编辑标题 T-1");
    fireEvent.change(editor, { target: { value: "新标题" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => {
      if (detailTitle().value !== "新标题") throw new Error(detailTitle().value);
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("Agent 建议卡片展示依据和证据会话，采纳与忽略分别确认", async () => {
  const store = new Store();
  store.add({ title: "上架检查", bucket: "later", listName: "LightSpace" });
  store.add({ title: "另一项", bucket: "focus", listName: "LightSpace" });
  const evidence = {
    threadId: "thr-ship",
    note: "",
    linkedAt: createdAt,
    threadTitle: "上架会话",
    threadStatus: "idle",
  };
  store.suggestions.push({
    id: "S-1",
    seq: 1,
    itemSeq: 1,
    itemId: "T-1",
    itemTitle: "上架检查",
    currentBucket: "later",
    currentListName: "LightSpace",
    currentSectionName: "",
    kind: "complete",
    patch: { completionNote: "流水线已绿" },
    reason: "关联会话已经合入并且没有剩余尾项",
    evidenceThreads: [evidence],
    status: "pending",
    actor: "agent:thr-ship",
    createdAt,
    resolvedAt: null,
  });
  store.suggestions.push({
    id: "S-2",
    seq: 2,
    itemSeq: 2,
    itemId: "T-2",
    itemTitle: "另一项",
    currentBucket: "later",
    currentListName: "Other",
    currentSectionName: "",
    kind: "update",
    patch: { bucket: "focus" },
    reason: "近期会话已经在推进这项",
    evidenceThreads: [],
    status: "pending",
    actor: "agent:thr-ship",
    createdAt,
    resolvedAt: null,
  });
  const slot = await mountedPanel(store);
  try {
    const section = await waitUntil(() => slot.getByLabelText("Agent 建议"));
    assert.ok(within(section).getByText("建议完成"));
    assert.ok(within(section).getByText("移入 Focus"));
    assert.ok(within(section).getByText("Later → Focus"));
    assert.ok(within(section).getByText("关联会话已经合入并且没有剩余尾项"));
    assert.ok(within(section).getByRole("button", { name: "打开会话 上架会话" }));
    assert.ok(slot.getAllByText("有建议").length >= 1);

    const completeCard = within(section).getByText("建议完成").closest("li");
    assert.ok(completeCard);
    fireEvent.click(within(completeCard).getByRole("button", { name: "采纳" }));
    await waitUntil(() =>
      assert.deepEqual(
        slot.inspection.rpcCalls.find((call) => call.method === "resolveSuggestion"),
        { method: "resolveSuggestion", input: { id: "S-1", decision: "accept" } },
      ),
    );

    const updateCard = within(await waitUntil(() => slot.getByLabelText("Agent 建议")))
      .getByText("移入 Focus")
      .closest("li");
    assert.ok(updateCard);
    fireEvent.click(within(updateCard).getByRole("button", { name: "忽略" }));
    await waitUntil(() =>
      assert.deepEqual(
        slot.inspection.rpcCalls.filter((call) => call.method === "resolveSuggestion").at(-1),
        { method: "resolveSuggestion", input: { id: "S-2", decision: "dismiss" } },
      ),
    );
    await waitFor(() => {
      if (slot.queryByLabelText("Agent 建议") !== null) throw new Error("suggestions still visible");
    });
    // React 19 may defer passive effects. Flush them before the file teardown
    // drops the JSDOM window.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    slot.lifecycle.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
});
