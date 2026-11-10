import { expect, it } from "vitest";
import { DshProxy } from "../src/dsh-proxy.js";
import type { Message } from "../src/wire.js";

function harness() {
  const up: Message[] = [],
    down: Message[] = [],
    side: Message[] = [];
  const proxy = new DshProxy(
    (m) => up.push(m),
    (m) => down.push(m),
    (m) => side.push(m),
  );
  return {
    proxy,
    up,
    down,
    side,
    claim(sessionId = "s") {
      const active = [...down]
        .reverse()
        .find(
          (message) =>
            message.method === "session/prompt" &&
            message.params?.sessionId === sessionId,
        )!;
      const blocks = active.params!.prompt as { text: string }[];
      const messageId = "original-" + active.id;
      proxy.fromSide({
        jsonrpc: "2.0",
        method: "enqueued",
        params: {
          sessionId,
          messageId,
          text: blocks.map((block) => block.text).join(""),
        },
      });
      proxy.fromSide({
        ...claimed(sessionId),
        params: { sessionId, messageId },
      });
    },
    admit(id: number, accepted = true, consumed = true) {
      if (accepted && consumed)
        proxy.fromSide({
          ...claimed(),
          params: { sessionId: "s", messageId: "msg" + id },
        });
      proxy.fromSide({
        ...admission(id, accepted),
        result: { accepted, messageId: "msg" + id },
      });
    },
    complete(id: number, reason = "end_turn") {
      proxy.fromAgent(response(id, reason));
      proxy.fromSide({
        jsonrpc: "2.0",
        method: "settled",
        params: {
          sessionId: down.find((message) => message.id === id)?.params
            ?.sessionId,
        },
      });
    },
  };
}
const prompt = (id: number, text = "correct", sessionId = "s"): Message => ({
  jsonrpc: "2.0",
  id,
  method: "session/prompt",
  params: { sessionId, prompt: [{ type: "text", text }] },
});
const claimed = (sessionId = "s"): Message => ({
  jsonrpc: "2.0",
  method: "claimed",
  params: { sessionId },
});
const response = (id: number, stopReason = "end_turn"): Message => ({
  jsonrpc: "2.0",
  id,
  result: { stopReason },
});
const admission = (id: number, accepted = true): Message => ({
  jsonrpc: "2.0",
  id,
  result: { accepted },
});

it("advertises steering only after the companion plugin initializes", () => {
  const h = harness();
  h.proxy.fromClient({ jsonrpc: "2.0", id: 1, method: "initialize" });
  expect(h.down).toEqual([]);
  h.proxy.fromSide({ jsonrpc: "2.0", method: "ready" });
  expect(h.down[0].method).toBe("initialize");
  h.proxy.fromAgent({
    jsonrpc: "2.0",
    id: 1,
    result: { agentInfo: { name: "DSH" } },
  });
  expect(h.up[0].result?._meta).toEqual({ midTurnSteering: true });
});
it("waits for the first input to be claimed, then steers without a second ACP prompt", () => {
  const h = harness();
  h.proxy.fromClient(prompt(1, "original"));
  h.proxy.fromClient(prompt(2));
  h.proxy.fromClient(prompt(3));
  expect(h.down).toHaveLength(1);
  expect(h.side).toEqual([]);
  h.claim();
  expect(h.side.map((m) => m.id)).toEqual([2, 3]);
  h.admit(2);
  h.admit(3);
  expect(h.up).toEqual([]);
  h.proxy.fromAgent({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s", update: { text: "done" } },
  });
  h.complete(1, "max_tokens");
  expect(h.up.map((m) => m.id)).toEqual([undefined, 1, 2, 3]);
  expect(h.up.slice(1).map((m) => m.result?.stopReason)).toEqual([
    "max_tokens",
    "max_tokens",
    "max_tokens",
  ]);
});
it("waits for late admission responses even if stdout completes first", () => {
  const h = harness();
  h.proxy.fromClient(prompt(1));
  h.claim();
  h.proxy.fromClient(prompt(2));
  h.complete(1);
  expect(h.up).toEqual([]);
  h.admit(2);
  expect(h.up.map((m) => m.id)).toEqual([1, 2]);
});
it("submits an idle-race input as a normal next turn after the active prompt settles", () => {
  const h = harness();
  h.proxy.fromClient(prompt(1));
  h.claim();
  h.proxy.fromClient(prompt(2));
  h.admit(2, false);
  expect(h.down).toHaveLength(1);
  h.complete(1);
  expect(h.down.map((m) => m.id)).toEqual([1, 2]);
  h.complete(2);
  expect(h.up.map((m) => m.id)).toEqual([1, 2]);
});
it("cancels queued and admitted inputs and allows a subsequent prompt", () => {
  const h = harness();
  h.proxy.fromClient(prompt(1));
  h.claim();
  h.proxy.fromClient(prompt(2));
  h.proxy.fromClient({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "s" },
  });
  expect(h.side.at(-1)?.method).toBe("cancel");
  h.admit(2, false);
  h.complete(1, "cancelled");
  expect(h.up.every((m) => m.result?.stopReason === "cancelled")).toBe(true);
  h.proxy.fromClient(prompt(3));
  expect(h.down.at(-1)?.id).toBe(3);
  h.complete(3);
  h.proxy.fromClient({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "s" },
  });
  h.proxy.fromClient(prompt(4));
  expect(h.down.at(-1)?.id).toBe(4);
});
it("contains failures to their session and propagates the official prompt's failure", () => {
  const h = harness();
  h.proxy.fromClient(prompt(1));
  h.claim();
  h.proxy.fromClient(prompt(2));
  h.proxy.fromClient(prompt(3, "other", "other"));
  h.admit(2);
  h.proxy.fromAgent({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "model failed" },
  });
  h.proxy.fromSide({
    jsonrpc: "2.0",
    method: "settled",
    params: { sessionId: "s" },
  });
  expect(h.up.map((m) => m.error?.message)).toEqual([
    "model failed",
    "model failed",
  ]);
  h.complete(3);
  expect(h.up.at(-1)?.result?.stopReason).toBe("end_turn");
});
it("requests interrupt delivery for unsupported content and settles requests on transport loss", () => {
  const h = harness();
  h.proxy.fromClient(prompt(1));
  h.proxy.fromClient({
    ...prompt(2),
    params: {
      sessionId: "s",
      prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
    },
  });
  expect(h.up[0].error?.code).toBe(-32602);
  h.proxy.fromClient(prompt(3));
  h.proxy.close("lost");
  h.proxy.close("lost again");
  expect(h.up.map((m) => m.id)).toEqual([2, 1, 3]);
  expect(h.up.slice(1).every((m) => m.error?.message === "lost")).toBe(true);
});

it("does not report an admitted but unclaimed message as delivered", () => {
  const h = harness();
  h.proxy.fromClient(prompt(1));
  h.claim();
  h.proxy.fromClient(prompt(2));
  h.admit(2, true, false);
  h.complete(1);
  expect(h.up.map((message) => message.id)).toEqual([2, 1]);
  expect(h.up[0].error).toMatchObject({ code: -32000 });
  expect(h.up[0].result).toBeUndefined();
  expect(h.up[1].result?.stopReason).toBe("end_turn");
});

it("drains stale claim notifications before opening a queued next turn", () => {
  const h = harness();
  h.proxy.fromClient(prompt(1));
  h.proxy.fromClient(prompt(2));
  h.proxy.fromAgent(response(1));
  expect(h.down.map((m) => m.id)).toEqual([1]);
  h.proxy.fromSide(claimed());
  expect(h.side.map((m) => m.method)).toEqual(["settle"]);
  h.proxy.fromSide({
    jsonrpc: "2.0",
    method: "settled",
    params: { sessionId: "s" },
  });
  h.proxy.fromClient(prompt(3));
  expect(h.down.map((m) => m.id)).toEqual([1, 2]);
  expect(h.side.map((m) => m.method)).toEqual(["settle"]);
  h.claim();
  expect(h.side.at(-1)?.id).toBe(3);
});
it("preserves arrival order when idle refusals interleave with new client input", () => {
  const h = harness();
  h.proxy.fromClient(prompt(1));
  h.claim();
  h.proxy.fromClient(prompt(2));
  h.proxy.fromClient(prompt(3));
  h.admit(2, false);
  h.proxy.fromClient(prompt(4));
  h.admit(3, false);
  h.complete(1);
  expect(h.down.at(-1)?.id).toBe(2);
  h.complete(2);
  expect(h.down.at(-1)?.id).toBe(3);
});

it("does not steer into restored pending work or a goal round before the active prompt is claimed", () => {
  const h = harness();
  const old = { sessionId: "s", messageId: "restored", text: "same input" };
  h.proxy.fromSide({ jsonrpc: "2.0", method: "enqueued", params: old });
  h.proxy.fromClient(prompt(1, "same input"));
  h.proxy.fromClient(prompt(2));
  h.proxy.fromSide({ jsonrpc: "2.0", method: "claimed", params: old });
  expect(h.side).toEqual([]);
  h.proxy.fromSide({
    jsonrpc: "2.0",
    method: "enqueued",
    params: { ...old, messageId: "current" },
  });
  h.proxy.fromSide({ jsonrpc: "2.0", method: "claimed", params: old });
  expect(h.side).toEqual([]);
  h.proxy.fromSide({
    jsonrpc: "2.0",
    method: "claimed",
    params: { ...old, messageId: "current" },
  });
  expect(h.side.map((message) => message.id)).toEqual([2]);
});
it("closes an active session with queued and admitted inputs without leaving pending responses", () => {
  const h = harness();
  h.proxy.fromClient(prompt(1));
  h.claim();
  h.proxy.fromClient(prompt(2));
  h.admit(2);
  h.proxy.fromClient(prompt(3));
  h.admit(3, false);
  h.proxy.fromClient(prompt(4));
  h.proxy.fromClient({
    jsonrpc: "2.0",
    id: 9,
    method: "session/close",
    params: { sessionId: "s" },
  });
  expect(h.side.at(-1)?.method).toBe("cancel");
  h.complete(1, "cancelled");
  h.proxy.fromAgent({ jsonrpc: "2.0", id: 9, result: {} });
  expect(
    h.up
      .filter((message) => message.result?.stopReason === "cancelled")
      .map((message) => message.id)
      .sort(),
  ).toEqual([1, 2, 3, 4]);
  const count = h.up.length;
  h.proxy.close();
  expect(h.up).toHaveLength(count);
});
it("keeps steering and cancellation independent for two running sessions", () => {
  const h = harness();
  h.proxy.fromClient(prompt(1));
  h.claim();
  h.proxy.fromClient(prompt(2));
  h.admit(2);
  h.proxy.fromClient(prompt(3, "other", "b"));
  h.claim("b");
  h.proxy.fromClient(prompt(4, "correction", "b"));
  h.proxy.fromSide({
    jsonrpc: "2.0",
    method: "claimed",
    params: { sessionId: "b", messageId: "b-steer" },
  });
  h.proxy.fromSide({
    jsonrpc: "2.0",
    id: 4,
    result: { accepted: true, messageId: "b-steer" },
  });
  h.proxy.fromClient({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "s" },
  });
  h.complete(1, "cancelled");
  expect(h.up.map((message) => message.id)).toEqual([1, 2]);
  h.complete(3);
  expect(h.up.slice(2).map((message) => message.result?.stopReason)).toEqual([
    "end_turn",
    "end_turn",
  ]);
});

it("requests interrupt delivery when the active original prompt is non-text", () => {
  const h = harness();
  h.proxy.fromClient({
    ...prompt(1),
    params: {
      sessionId: "s",
      prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
    },
  });
  h.proxy.fromClient(prompt(2));
  expect(h.up[0]).toMatchObject({
    id: 2,
    error: {
      code: -32602,
      message: expect.stringMatching(/already in flight/i),
    },
  });
  expect(h.side).toEqual([]);
  expect(h.down.map((message) => message.id)).toEqual([1]);
  h.complete(1);
  expect(h.up[1]).toMatchObject({ id: 1, result: { stopReason: "end_turn" } });
});
it("ignores a different newly inserted user prompt before matching the active text", () => {
  const h = harness();
  h.proxy.fromClient(prompt(1, "current"));
  h.proxy.fromClient(prompt(2));
  const other = {
    sessionId: "s",
    messageId: "other",
    text: "Reference attachments for the goal objective.",
  };
  h.proxy.fromSide({ jsonrpc: "2.0", method: "enqueued", params: other });
  h.proxy.fromSide({ jsonrpc: "2.0", method: "claimed", params: other });
  expect(h.side).toEqual([]);
  h.claim();
  expect(h.side.map((message) => message.id)).toEqual([2]);
});
