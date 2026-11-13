import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { JSDOM } from "jsdom";
import {
  TODO_CHANGED_EVENT,
  rpcContract,
  type TodoCounts,
  type TodoFormalBucket,
  type TodoItem,
  type TodoSnapshot,
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

const createdAt = "2026-11-13T10:00:00.000Z";

function makeItem(seq: number, overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: `T-${seq}`,
    seq,
    title: `待办 ${seq}`,
    bucket: "focus",
    notes: "",
    nextStep: "",
    proposalReason: null,
    completedAt: null,
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
    const counts: TodoCounts = {
      inbox: active.filter((item) => item.bucket === "inbox").length,
      focus: bucket("focus").length,
      later: bucket("later").length,
      waiting: bucket("waiting").length,
      open: formal.length,
      done: this.items.filter((item) => item.completedAt !== null).length,
    };
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
        .filter((item) => item.completedAt !== null)
        .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))
        .slice(0, 20),
      counts,
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
    quickAdd: (input: { title: string; bucket?: TodoFormalBucket }) =>
      store.add({ title: input.title, bucket: input.bucket ?? "focus" }),
    update: (input: {
      id: string;
      title?: string;
      bucket?: TodoFormalBucket;
      notes?: string;
      nextStep?: string;
    }) => {
      const item = store.find(input.id);
      if (input.title !== undefined) item.title = input.title;
      if (input.bucket !== undefined) item.bucket = input.bucket;
      if (input.notes !== undefined) item.notes = input.notes;
      if (input.nextStep !== undefined) item.nextStep = input.nextStep;
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

test("一行输入按 Enter 秒加；分组胶囊切换生效；中文输入法组合态不误提交", async () => {
  const store = new Store();
  const slot = await mountedPanel(store);
  try {
    await slot.findByText("还没有待办。");
    assert.ok(slot.queryByLabelText("待确认提议") === null);
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

    fireEvent.click(slot.getByRole("button", { name: "Later" }));
    assert.equal(
      slot.getByRole("button", { name: "Later" }).getAttribute("aria-pressed"),
      "true",
    );
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
  const item = store.add({ title: "写面板", nextStep: "先画布局" });
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
    const inbox = await waitUntil(() => slot.getByLabelText("待确认提议"));
    assert.ok(within(inbox).getByText("会议里反复提到，需要独立产出"));
    assert.ok(within(inbox).getByRole("button", { name: "打开会话 设计讨论" }));

    const acceptRow = within(inbox).getByText("招设计师").closest("li");
    assert.ok(acceptRow);
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

    const defaultRow = within(await waitUntil(() => slot.getByLabelText("待确认提议")))
      .getByText("直接采纳")
      .closest("li");
    assert.ok(defaultRow);
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

    const inboxAgain = await waitUntil(() => slot.getByLabelText("待确认提议"));
    const mergeRow = within(inboxAgain).getByText("合并提案").closest("li");
    assert.ok(mergeRow);
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

    const dismissRow = within(await waitUntil(() => slot.getByLabelText("待确认提议")))
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
      if (slot.queryByLabelText("待确认提议") !== null) throw new Error("inbox still visible");
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

test("行内详情保存标题、下一步、备注与分组，并可删除条目", async () => {
  const store = new Store();
  store.add({ title: "写前端", nextStep: "旧下一步", notes: "旧备注" });
  const slot = await mountedPanel(store);
  try {
    await slot.findByText("写前端");
    fireEvent.click(slot.getByText("写前端"));
    fireEvent.change(slot.getByLabelText("标题 T-1"), { target: { value: "写清亮前端" } });
    fireEvent.change(slot.getByLabelText("分组 T-1"), { target: { value: "waiting" } });
    fireEvent.change(slot.getByLabelText("下一步 T-1"), { target: { value: "实现面板" } });
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
            nextStep: "实现面板",
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
        label: "2 项待确认提议",
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
  store.add({ title: "写前端", nextStep: "旧下一步", notes: "旧备注" });
  const slot = await mountedPanel(store);
  try {
    await slot.findByText("写前端");
    fireEvent.click(slot.getByText("写前端"));
    const nextStep = () => slot.getByLabelText("下一步 T-1") as HTMLInputElement;
    const title = () => slot.getByLabelText("标题 T-1") as HTMLInputElement;
    assert.equal(nextStep().value, "旧下一步");

    const item = store.find("T-1");
    item.nextStep = "服务端下一步";
    item.updatedAt = "2026-11-13T10:00:01.000Z";
    await slot.behavior.emitRealtime(TODO_CHANGED_EVENT, {});
    await waitFor(() => {
      if (nextStep().value !== "服务端下一步") throw new Error(nextStep().value);
    });

    fireEvent.change(nextStep(), { target: { value: "草稿下一步" } });
    item.title = "服务端新标题";
    item.nextStep = "服务端又改了下一步";
    item.notes = "服务端备注";
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
    await slot.findByRole("button", { name: "打开会话 后台会话" });
    assert.equal(nextStep().value, "草稿下一步");
    assert.equal(title().value, "写前端");
    assert.equal((slot.getByLabelText("备注 T-1") as HTMLTextAreaElement).value, "旧备注");
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
    assert.deepEqual(slot.inspection.navigateCalls.at(-1), {
      method: "toCompose",
      options: {
        focusPrompt: true,
        initialPrompt: "推进待办 T-1：继续做\n@thread:thr-old",
        projectId: "proj-1",
        environmentId: "env-1",
      },
    });

    fireEvent.click(slot.getByText("继续做"));
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
