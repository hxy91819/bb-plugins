import { test, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  definePluginApp,
  type PluginCommandRegistration,
} from "@get-bb/plugin-sdk/app";
import { pageSize, searchMessages, type SearchInput } from "./search";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const keys = [
  "window",
  "document",
  "HTMLElement",
  "MutationObserver",
  "navigator",
] as const;
const descriptors = keys.map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
for (const key of keys)
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  });
const { loadPluginApp, renderSlot } =
  await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, waitFor } = await import("@testing-library/react");
const { default: app } = await import("./app");
after(() => {
  dom.window.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const match = (seq: number, text = `needle ${seq}`) => ({
  sourceSeq: seq,
  sourceKind: "assistant_message",
  text,
  highlightRanges: [{ start: 0, end: 6 }],
});

test("command and header open the same search, keyboard navigation crosses pages, Escape preserves other tabs", async () => {
  const commands: PluginCommandRegistration[] = [];
  const captured = await loadPluginApp(
    definePluginApp((builder) =>
      app.setup({
        ...builder,
        commands: {
          register(command) {
            commands.push(command);
            builder.commands.register(command);
          },
        },
      }),
    ),
  );
  const search = captured.threadPanelActions[0];
  const opens: unknown[] = [];
  const context = {
    threadId: "t",
    projectId: "p",
    openPanel: (options: unknown) => {
      opens.push(options);
      return true;
    },
  };
  const find = commands.find((command) => command.id === "find")!;
  assert.equal(find.isAvailable?.({ ...context, threadId: null }), false);
  assert.deepEqual(find.defaultShortcut, { key: "f", mod: true, shift: true });
  await find.run(context);
  assert.deepEqual(opens, [{ actionId: "find" }]);
  const calls: SearchInput[] = [];
  const updates: unknown[] = [];
  const tab = {
    kind: "plugin-panel" as const,
    id: "search",
    pluginId: "thread-search",
    actionId: "find",
    title: "Find",
    paramsJson: null,
  };
  const other = { kind: "git-diff" as const, id: "diff" };
  const slot = renderSlot(
    search,
    { threadId: "t", params: null },
    {
      sdk: {
        threads: {
          ...{
            experimental_searchMessages: async (input: SearchInput) => {
              calls.push(input);
              return {
                total: 27,
                matches: Array.from(
                  { length: Math.min(pageSize, 27 - input.offset) },
                  (_, index) => match(input.offset + index + 1),
                ),
              };
            },
          },
          tabs: {
            get: async () => ({ revision: 3, tabs: [other, tab] }),
            update: async (input) => {
              updates.push(input);
              return { revision: 4, tabs: input.tabs };
            },
          },
        },
      },
    },
  );
  try {
    const field = slot.getByRole("searchbox");
    fireEvent.change(field, { target: { value: "needle" } });
    await slot.findByText("0 / 27 matching messages");
    assert.equal(slot.container.querySelector("mark")?.textContent, "needle");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      assert.deepEqual(slot.inspection.navigateCalls.at(-1), {
        method: "toThread",
        threadId: "t",
        options: { experimental_messageSeq: 1 },
      }),
    );
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    await slot.findByText("27 / 27 matching messages");
    await waitFor(() =>
      assert.deepEqual(slot.inspection.navigateCalls.at(-1), {
        method: "toThread",
        threadId: "t",
        options: { experimental_messageSeq: 27 },
      }),
    );
    assert.equal(calls.at(-1)?.offset, 25);
    fireEvent.keyDown(field, { key: "Enter" });
    await slot.findByText("1 / 27 matching messages");
    assert.equal(calls.at(-1)?.offset, 0);
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() =>
      assert.deepEqual(updates, [
        { threadId: "t", expectedRevision: 3, tabs: [other] },
      ]),
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("late results cannot replace a newer query or navigate to an old message", async () => {
  const captured = await loadPluginApp(app);
  let resolveOld: (value: unknown) => void = () => {};
  let oldSignal: AbortSignal | null = null;
  const slot = renderSlot(
    captured.threadPanelActions[0],
    { threadId: "t", params: null },
    {
      sdk: {
        threads: {
          tabs: {},
          ...{
            experimental_searchMessages: async (input: SearchInput) => {
              if (input.query === "old") {
                oldSignal = input.signal;
                return new Promise((resolve) => {
                  resolveOld = resolve;
                });
              }
              return { total: 1, matches: [match(100, "new needle")] };
            },
          },
        },
      },
    },
  );
  try {
    const field = slot.getByRole("searchbox");
    fireEvent.change(field, { target: { value: "old" } });
    await waitFor(() => assert.ok(oldSignal));
    fireEvent.change(field, { target: { value: "new" } });
    await slot.findByText("0 / 1 matching messages");
    resolveOld({ total: 1, matches: [match(1, "old needle")] });
    await waitFor(() => assert.equal(oldSignal?.aborted, true));
    assert.equal(slot.queryByText("old needle"), null);
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    assert.deepEqual(slot.inspection.navigateCalls, []);
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      assert.deepEqual(slot.inspection.navigateCalls.at(-1), {
        method: "toThread",
        threadId: "t",
        options: { experimental_messageSeq: 100 },
      }),
    );
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => assert.equal(slot.inspection.navigateCalls.length, 2));
  } finally {
    slot.lifecycle.unmount();
  }
});

test("unsupported hosts explain the missing capability and search errors can be retried", async () => {
  await assert.rejects(
    searchMessages(
      {},
      {
        threadId: "t",
        query: "x",
        limit: 25,
        offset: 0,
        signal: new AbortController().signal,
      },
    ),
    /requires a BB build/,
  );
  const captured = await loadPluginApp(app);
  let fail = true;
  const slot = renderSlot(
    captured.threadPanelActions[0],
    { threadId: "t", params: null },
    {
      sdk: {
        threads: {
          tabs: {},
          ...{
            experimental_searchMessages: async () => {
              if (fail) throw new Error("Search unavailable");
              return { total: 0, matches: [] };
            },
          },
        },
      },
    },
  );
  try {
    fireEvent.change(slot.getByRole("searchbox"), { target: { value: "x" } });
    assert.equal(
      (await slot.findByRole("alert")).textContent,
      "Search unavailable",
    );
    fail = false;
    fireEvent.click(slot.getByRole("button", { name: "Refresh search" }));
    await slot.findByText("No matching messages.");
    assert.equal(slot.queryByRole("alert"), null);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a collapsed retained search does not expose navigation commands", async () => {
  const commands: PluginCommandRegistration[] = [];
  const captured = await loadPluginApp(
    definePluginApp((builder) =>
      app.setup({
        ...builder,
        commands: {
          register(command) {
            commands.push(command);
            builder.commands.register(command);
          },
        },
      }),
    ),
  );
  const slot = renderSlot(captured.threadPanelActions[0], {
    threadId: "collapse",
    params: null,
  });
  try {
    const panel = slot.container.firstElementChild!;
    Object.defineProperty(panel, "getClientRects", {
      value: () => [new dom.window.DOMRect(0, 0, 400, 600)],
    });
    const next = commands.find((command) => command.id === "next")!;
    const context = {
      threadId: "collapse",
      projectId: "p",
      openPanel: () => true,
    };
    assert.equal(next.isAvailable?.(context), true);
    slot.container.setAttribute("inert", "");
    slot.container.setAttribute("aria-hidden", "true");
    assert.equal(next.isAvailable?.(context), false);
    slot.container.removeAttribute("inert");
    slot.container.removeAttribute("aria-hidden");
    assert.equal(next.isAvailable?.(context), true);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("reopening a retained panel focuses search after the host releases inert", async () => {
  const commands: PluginCommandRegistration[] = [];
  const captured = await loadPluginApp(
    definePluginApp((builder) =>
      app.setup({
        ...builder,
        commands: {
          register(command) {
            commands.push(command);
            builder.commands.register(command);
          },
        },
      }),
    ),
  );
  const slot = renderSlot(captured.threadPanelActions[0], {
    threadId: "focus",
    params: null,
  });
  try {
    const panel = slot.container.firstElementChild!;
    Object.defineProperty(panel, "getClientRects", {
      value: () => [new dom.window.DOMRect(0, 0, 400, 600)],
    });
    const field = slot.getByRole("searchbox");
    const nativeFocus = field.focus.bind(field);
    Object.defineProperty(field, "focus", {
      value: () => {
        if (!field.closest("[inert]")) nativeFocus();
      },
    });
    field.blur();
    slot.container.setAttribute("inert", "");
    slot.container.setAttribute("aria-hidden", "true");
    await commands
      .find((command) => command.id === "find")!
      .run({ threadId: "focus", projectId: "p", openPanel: () => true });
    assert.equal(document.activeElement === field, false);
    slot.container.removeAttribute("inert");
    slot.container.removeAttribute("aria-hidden");
    await waitFor(() => assert.equal(document.activeElement === field, true));
  } finally {
    slot.lifecycle.unmount();
  }
});
