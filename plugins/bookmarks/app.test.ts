import { test, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { listInput, type Bookmark } from "./contract";
import { createBookmarksApp } from "./app";
import { formatDate, readLanguageSetting, resolveLanguage } from "./i18n";
const app = createBookmarksApp("zh-CN");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
const keys = ["window", "document", "HTMLElement", "MutationObserver", "navigator"] as const;
const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, waitFor } = await import("@testing-library/react");
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const bookmark = (id: string, threadId: string, projectId = "p1"): Bookmark => ({
  id, threadId, projectId, projectName: `项目 ${projectId}`, threadTitle: `会话 ${threadId}`,
  messageSeq: 41, text: `文字 ${id}`, note: "", createdAt: "2026-10-16T12:00:00Z",
});

test("选区和消息按钮保存原文，成功打开同一书签面板，失败不打开", async () => {
  const previousFetch = globalThis.fetch;
  const previousRuntime = Object.getOwnPropertyDescriptor(globalThis, "__bbPluginRuntime");
  const requests: unknown[] = [];
  const opens: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/v1/plugins/bookmarks/rpc/add");
    assert.equal(init?.method, "POST");
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: bookmark(`new-${requests.length}`, "thread-a") });
  };
  try {
    let pin: unknown;
    const captured = await loadPluginApp(definePluginApp((builder) => app.setup({
      ...builder,
      slots: {
        ...builder.slots,
        threadPanelAction(registration) {
          pin = Reflect.get(registration, "experimental_pinned");
          builder.slots.threadPanelAction(registration);
        },
      },
    })));
    assert.equal(pin, true);
    assert.deepEqual(captured.navPanels, []);
    assert.equal(captured.threadPanelActions[0].id, "bookmarks");
    const action = captured.messageActions.find((item) => item.id === "add-bookmark")!;
    const context = {
      threadId: "thread-a",
      message: {
        id: "msg-41",
        threadId: "thread-a",
        role: "assistant" as const,
        text: "整条回复：甲 乙 丙",
        sourceSeqEnd: 50,
        experimental_messageSeq: 41,
      },
      composer: null,
      openPanel: (options: unknown) => { opens.push(options); return true; },
    };
    await action.run({ ...context, selectedText: " 乙\n" });
    await action.run(context);
    assert.deepEqual(requests, [
      { threadId: "thread-a", messageSeq: 41, text: " 乙\n" },
      { threadId: "thread-a", messageSeq: 41, text: "整条回复：甲 乙 丙" },
    ]);
    assert.deepEqual(opens, [{ actionId: "bookmarks" }, { actionId: "bookmarks" }]);
    globalThis.fetch = async () => Response.json({ ok: false }, { status: 500 });
    await action.run(context);
    assert.equal(opens.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRuntime) Object.defineProperty(globalThis, "__bbPluginRuntime", previousRuntime);
    else Reflect.deleteProperty(globalThis, "__bbPluginRuntime");
  }
});

test("面板默认仅当前项目、当前会话优先；取消过滤按项目分组；搜索、跳转及新增定位", async () => {
  let scrolled: string | null = null;
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolled = this.getAttribute("data-bookmark-id"); };
  const captured = await loadPluginApp(app);
  const rows = [bookmark("foreign", "foreign", "p2"), bookmark("other", "other"), bookmark("current", "current")];
  const slot = renderSlot(captured.threadPanelActions[0], { threadId: "current", params: null }, {
    sdk: { threads: { get: async () => makeThreadResponse({ id: "current", projectId: "p1" }) } },
    rpc: { list: (value) => {
      const input = listInput.parse(value);
      const matches = rows.filter((row) => (!input.projectId || row.projectId === input.projectId) && row.text.includes(input.query ?? ""));
      return { bookmarks: matches.slice(input.offset, input.offset + input.limit), total: matches.length };
    } },
  });
  const headings = () => [...slot.container.querySelectorAll("h2")].map((node) => node.textContent);
  const previousFetch = globalThis.fetch;
  try {
    await slot.findByText("共 2 条");
    assert.equal((slot.getByRole("checkbox") as HTMLInputElement).checked, true);
    assert.deepEqual(headings(), ["会话 current", "会话 other"]);
    assert.equal(slot.queryByText("文字 foreign"), null);
    fireEvent.click(slot.getByRole("checkbox"));
    await slot.findByText("共 3 条");
    assert.deepEqual(headings(), ["项目 p2", "项目 p1"]);
    fireEvent.change(slot.getByRole("textbox"), { target: { value: "foreign" } });
    await slot.findByText("共 1 条");
    fireEvent.click(slot.getByRole("button", { name: "打开书签：会话 foreign" }));
    assert.deepEqual(slot.inspection.navigateCalls.at(-1), {
      method: "toThread", threadId: "foreign", options: { split: false, experimental_messageSeq: 41 },
    });
    const added = bookmark("new-target", "current");
    globalThis.fetch = async () => { rows.unshift(added); return Response.json({ ok: true, result: added }); };
    await captured.messageActions[0].run({ threadId: "current", composer: null,
      message: { id: "m", threadId: "current", role: "user", text: "新文字", sourceSeqEnd: 41, experimental_messageSeq: 41 },
      openPanel: () => true,
    });
    await slot.findByText("共 3 条");
    await waitFor(() => assert.equal(scrolled, "new-target"));
    assert.equal((slot.getByRole("checkbox") as HTMLInputElement).checked, true);
    assert.equal((slot.getByRole("textbox") as HTMLInputElement).value, "");
    assert.ok(slot.container.querySelector('[data-bookmark-id="new-target"]')?.className.includes("ring-2"));
    // Loading spans server pages: current-thread sorting must not stop at the first 200 rows.
    rows.splice(0, rows.length, ...Array.from({ length: 201 }, (_, i) => bookmark(`older-${i}`, "other")), bookmark("last", "current"));
    await slot.behavior.emitRealtime("changed", {});
    await slot.findByText("共 202 条");
    assert.deepEqual(headings(), ["会话 current", "会话 other"]);
    assert.ok(slot.getByText("文字 last"));
  } finally {
    globalThis.fetch = previousFetch;
    slot.lifecycle.unmount();
  }
});


test("browser language and explicit overrides apply to registration, panel, dates and errors", async () => {
  for (const [setting, browserLanguage, language] of [
    ["auto", "zh-TW", "zh-CN"], ["auto", "zh-CN", "zh-CN"],
    ["auto", "en-US", "en"], ["auto", "fr-FR", "en"],
    ["en", "zh-CN", "en"], ["zh-CN", "en-US", "zh-CN"],
    [undefined, "zh-HK", "zh-CN"], ["invalid", "de-DE", "en"],
  ] as const) {
    assert.equal(resolveLanguage(setting, browserLanguage), language);
    const zh = language === "zh-CN";
    const captured = await loadPluginApp(createBookmarksApp(setting, browserLanguage));
    assert.equal(captured.messageActions[0].title, zh ? "加书签" : "Add bookmark");
    assert.equal(captured.threadPanelActions[0].title, zh ? "书签" : "Bookmarks");
    let fail = false;
    const slot = renderSlot(captured.threadPanelActions[0], { threadId: "t", params: null }, {
      sdk: { threads: { get: async () => makeThreadResponse({ id: "t", projectId: "p1" }) } },
      rpc: { list: () => {
        if (fail) throw new Error("Server detail must not leak into UI");
        return { bookmarks: [{ ...bookmark("localized", "t"), threadTitle: "" }], total: 1 };
      } },
    });
    try {
      await slot.findByText(zh ? "共 1 条" : "1 bookmark");
      assert.deepEqual(slot.inspection.navigateCalls, []);

      assert.ok(slot.getByRole("checkbox", { name: zh ? "仅当前项目" : "Current project only" }));
      assert.ok(slot.getByRole("button", { name: zh ? "打开书签：未命名会话" : "Open bookmark: Untitled thread" }));
      assert.equal(slot.container.querySelector("time")?.textContent,
        new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "medium" }).format(new Date("2026-10-16T12:00:00Z")));
      assert.equal(formatDate("2026-10-16T12:00:00Z", language), slot.container.querySelector("time")?.textContent);
      fireEvent.click(slot.getByRole("button", { name: zh ? "改备注" : "Edit note" }));
      assert.ok(slot.getByRole("button", { name: zh ? "保存备注" : "Save note" }));
      assert.ok(slot.getByRole("textbox", { name: zh ? "书签备注" : "Bookmark note" }));
      fail = true;
      await slot.behavior.emitRealtime("changed", {});
      await slot.findByRole("alert");
      assert.ok(slot.getByText(zh ? "加载书签失败，请重试" : "Could not load bookmarks. Please try again."));
      assert.equal(slot.queryByText("Server detail must not leak into UI"), null);
    } finally { slot.lifecycle.unmount(); }
  }
});

test("registration settings reader handles saved overrides and unavailable settings", async () => {
  const fetcher = (body: unknown, status = 200) => (async (input: unknown) => {
    assert.equal(input, "/api/v1/plugins/bookmarks/settings");
    return Response.json(body, { status });
  }) as typeof fetch;
  for (const language of ["auto", "en", "zh-CN"]) {
    assert.equal(await readLanguageSetting(fetcher({ ok: true, values: { language } })), language);
  }
  assert.equal(await readLanguageSetting(fetcher({ ok: false }, 404)), undefined);
  assert.equal(await readLanguageSetting(fetcher(null)), undefined);
  assert.equal(await readLanguageSetting((async () => { throw new Error("offline"); }) as typeof fetch), undefined);
});
