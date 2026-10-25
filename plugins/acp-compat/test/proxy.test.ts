import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpProxy } from "../src/proxy.js";
import { adapterFor } from "../src/adapters/index.js";
import type { Message } from "../src/wire.js";

let up: Message[], down: Message[], proxy: AcpProxy;
function request(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
) {
  proxy.fromClient({ jsonrpc: "2.0", id, method, params });
}
function response(sent: Message, result: Record<string, unknown>) {
  proxy.fromAgent({ jsonrpc: "2.0", id: sent.id, result });
}
function error(sent: Message, code: number, message: string) {
  proxy.fromAgent({ jsonrpc: "2.0", id: sent.id, error: { code, message } });
}
function prompt(id: number, text = "change", sessionId = "s") {
  request(id, "session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }],
  });
}
function observe(owner = "run-1", insertedId?: string, sessionId = "s") {
  proxy.fromAgent({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: insertedId ? "user_message_chunk" : "tool_call",
        messageId: insertedId,
        _meta: { "codebuddy.ai/conversationRequestId": owner },
      },
    },
  });
}
function initialize(supported = true) {
  request(1, "initialize");
  response(down.at(-1)!, { protocolVersion: 1, _meta: { other: true } });
  expect(down.at(-1)?.method).toBe("session/steer");
  error(
    down.at(-1)!,
    supported ? -32602 : -32601,
    supported ? 'Steer operation requires "sessionId"' : "Method not found",
  );
}
function cancel(sessionId = "s") {
  proxy.fromClient({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId },
  });
}
function replies(id: number) {
  return up.filter((m) => m.id === id && !m.method);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  up = [];
  down = [];
  proxy = new AcpProxy(
    adapterFor("codebuddy"),
    (m) => up.push(m),
    (m) => down.push(m),
  );
});
afterEach(() => {
  proxy.close();
  vi.useRealTimers();
});

describe("native steering protocol", () => {
  it("keeps uninserted admitted input visibly failed when a later input interrupts", () => {
    initialize();
    prompt(2);
    observe();
    prompt(3);
    response(down.at(-1)!, { steered: true, ownerRequestId: "run-1" });
    prompt(4, "/compact");
    expect(replies(4)[0].error?.code).toBe(-32602);
    cancel();
    expect(replies(3)[0].error?.code).toBe(-32000);
    expect(replies(3)[0].result).toBeUndefined();
  });
  it("preserves an input already confirmed inserted when Stop races its admission", () => {
    initialize();
    prompt(2);
    observe();
    prompt(3);
    observe("run-1", String(down.at(-1)!.params?.clientUserMessageId));
    cancel();
    expect(replies(3)[0].result?.stopReason).toBe("end_turn");
  });
  it("clears an idle cancellation before the next run can receive steer", () => {
    initialize();
    cancel();
    prompt(2);
    vi.advanceTimersByTime(250);
    expect(down.at(-1)?.method).toBe("session/prompt");
    observe("run-2");
    prompt(3);
    expect(down.at(-1)).toMatchObject({
      method: "session/steer",
      params: { expectedRequestId: "run-2" },
    });
  });
  it("negotiates support without a model run and preserves other metadata", () => {
    initialize();
    expect(replies(1)[0].result?._meta).toEqual({
      other: true,
      midTurnSteering: true,
    });
    expect(down.map((m) => m.method)).toEqual(["initialize", "session/steer"]);
  });
  it("recognizes the agent SDK's invalidParams data envelope", () => {
    request(1, "initialize");
    response(down[0], { protocolVersion: 1 });
    proxy.fromAgent({
      jsonrpc: "2.0",
      id: down.at(-1)!.id,
      error: {
        code: -32602,
        message: "Invalid params",
        data: 'Steer operation requires "sessionId"',
      },
    });
    expect(replies(1)[0].result?._meta).toMatchObject({
      midTurnSteering: true,
    });
  });
  it("retains interrupt behavior when the extension is absent or the probe times out", () => {
    initialize(false);
    expect(replies(1)[0].result?._meta).toMatchObject({
      midTurnSteering: false,
    });
    prompt(2);
    const first = down.at(-1)!;
    prompt(3);
    expect(down.at(-1)).toBe(first);
    response(first, { stopReason: "end_turn" });
    expect(down.at(-1)?.method).toBe("session/prompt");
    expect(replies(3)).toHaveLength(0);
  });
  it("settles initialize when the harmless probe receives no response", () => {
    request(1, "initialize");
    response(down[0], { protocolVersion: 1 });
    vi.advanceTimersByTime(3000);
    expect(replies(1)[0].result?._meta).toMatchObject({
      midTurnSteering: false,
    });
  });
  it("keeps the main prompt active and resolves steer only after matching insertion", () => {
    initialize();
    prompt(2);
    const main = down.at(-1)!;
    observe();
    prompt(3);
    const steer = down.at(-1)!;
    expect(steer).toMatchObject({
      method: "session/steer",
      params: { expectedRequestId: "run-1" },
    });
    response(steer, { steered: true, ownerRequestId: "run-1" });
    expect(replies(3)).toHaveLength(0);
    const mid = String(steer.params?.clientUserMessageId);
    observe("wrong-run", mid);
    expect(replies(3)).toHaveLength(0);
    observe("run-1", mid, "another-session");
    expect(replies(3)).toHaveLength(0);
    observe("run-1", mid);
    expect(replies(3)[0].result).toEqual({ stopReason: "end_turn" });
    expect(replies(2)).toHaveLength(0);
    response(main, { stopReason: "end_turn" });
    expect(replies(2)).toHaveLength(1);
    expect(down.filter((m) => m.method === "session/cancel")).toHaveLength(0);
  });
  it("supports insertion notification arriving before its admission response", () => {
    initialize();
    prompt(2);
    const main = down.at(-1)!;
    observe();
    prompt(3);
    const steer = down.at(-1)!;
    observe("run-1", String(steer.params?.clientUserMessageId));
    response(main, { stopReason: "end_turn" });
    expect(replies(3)).toHaveLength(0);
    response(steer, { steered: true, ownerRequestId: "run-1" });
    expect(replies(3)[0].result).toEqual({ stopReason: "end_turn" });
  });
  it("handles multiple steers independently and never replaces one silently", () => {
    initialize();
    prompt(2);
    observe();
    prompt(3, "first");
    const first = down.at(-1)!;
    prompt(4, "second");
    const second = down.at(-1)!;
    expect(first.params?.clientUserMessageId).not.toBe(
      second.params?.clientUserMessageId,
    );
    response(second, { steered: true, ownerRequestId: "run-1" });
    response(first, { steered: true, ownerRequestId: "run-1" });
    observe("run-1", String(first.params?.clientUserMessageId));
    observe("run-1", String(second.params?.clientUserMessageId));
    expect(replies(3)).toHaveLength(1);
    expect(replies(4)).toHaveLength(1);
  });
  it.each(["idle", "stale"])(
    "rejects %s without claiming successful delivery",
    (reason) => {
      initialize();
      prompt(2);
      observe();
      prompt(3);
      response(down.at(-1)!, { steered: false, reason });
      expect(replies(3)[0].error).toMatchObject({
        code: -32602,
        message: expect.stringMatching(/already in flight/),
      });
    },
  );
  it("fails ambiguous admission without permitting automatic replay", () => {
    initialize();
    prompt(2);
    observe();
    prompt(3);
    vi.advanceTimersByTime(3000);
    expect(replies(3)[0].error?.code).toBe(-32000);
  });
  it("fails an accepted input if its run finishes without an insertion receipt", () => {
    initialize();
    prompt(2);
    const main = down.at(-1)!;
    observe();
    prompt(3);
    response(down.at(-1)!, { steered: true, ownerRequestId: "run-1" });
    response(main, { stopReason: "end_turn" });
    expect(replies(3)[0].error?.code).toBe(-32000);
  });
  it.each(["/compact", "/some-skill"])(
    "requests interrupt delivery for command %s",
    (text) => {
      initialize();
      prompt(2);
      observe();
      prompt(3, text);
      expect(replies(3)[0].error?.code).toBe(-32602);
      expect(down.filter((m) => m.params?.clientUserMessageId)).toHaveLength(0);
    },
  );
  it("requests interrupt delivery for images and unknown run ownership", () => {
    initialize();
    prompt(2);
    prompt(3);
    expect(replies(3)[0].error?.code).toBe(-32602);
    observe();
    request(4, "session/prompt", {
      sessionId: "s",
      prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
    });
    expect(replies(4)[0].error?.code).toBe(-32602);
  });
  it("cancels outstanding steer requests once and ignores their late admission", () => {
    initialize();
    prompt(2);
    const main = down.at(-1)!;
    observe();
    prompt(3);
    const steer = down.at(-1)!;
    cancel();
    expect(replies(3)[0].error?.code).toBe(-32000);
    response(steer, { steered: true, ownerRequestId: "run-1" });
    observe("run-1", String(steer.params?.clientUserMessageId));
    response(main, { stopReason: "cancelled" });
    expect(replies(3)).toHaveLength(1);
    prompt(4);
    expect(down.at(-1)?.method).toBe("session/cancel");
    vi.advanceTimersByTime(250);
    expect(down.at(-1)?.method).toBe("session/prompt");
  });
});

describe("transport and interrupt recovery", () => {
  it("preserves passthrough agents including concurrent prompt semantics", () => {
    proxy = new AcpProxy(
      adapterFor("passthrough"),
      (m) => up.push(m),
      (m) => down.push(m),
    );
    prompt(1);
    prompt(2);
    expect(down.map((m) => m.method)).toEqual([
      "session/prompt",
      "session/prompt",
    ]);
    response(down[1], { stopReason: "end_turn" });
    expect(replies(2)).toHaveLength(1);
  });
  it("cancels queued inputs and retries missed active cancellation before releasing recovery", () => {
    initialize(false);
    prompt(2);
    const main = down.at(-1)!;
    prompt(3);
    cancel();
    expect(replies(3)[0].result?.stopReason).toBe("cancelled");
    prompt(4);
    vi.advanceTimersByTime(100);
    expect(down.filter((m) => m.method === "session/cancel")).toHaveLength(2);
    response(main, { stopReason: "cancelled" });
    vi.advanceTimersByTime(249);
    expect(down.at(-1)?.method).toBe("session/cancel");
    vi.advanceTimersByTime(1);
    const recovery = down.at(-1)!;
    expect(recovery.method).toBe("session/prompt");
    response(recovery, { stopReason: "cancelled" });
    expect(replies(4)).toHaveLength(0);
    vi.advanceTimersByTime(50);
    response(down.at(-1)!, { stopReason: "end_turn" });
    expect(replies(4)[0].result?.stopReason).toBe("end_turn");
  });
  it("cancels recovery waiting in a timer and never starts it later", () => {
    initialize(false);
    prompt(2);
    const main = down.at(-1)!;
    cancel();
    response(main, { stopReason: "cancelled" });
    prompt(3);
    cancel();
    expect(replies(3)[0].result?.stopReason).toBe("cancelled");
    const count = down.length;
    vi.advanceTimersByTime(5000);
    expect(down).toHaveLength(count);
  });
  it("settles forwarded requests, active prompts, steers and queued inputs on process exit", () => {
    initialize();
    prompt(2);
    observe();
    prompt(3);
    request(4, "session/list");
    proxy.close();
    proxy.close();
    for (const id of [2, 3, 4]) expect(replies(id)).toHaveLength(1);
    const count = down.length;
    vi.advanceTimersByTime(10000);
    expect(down).toHaveLength(count);
  });
  it("forwards agent permission requests and client responses without confusing request IDs", () => {
    initialize();
    const agent: Message = {
      jsonrpc: "2.0",
      id: 3,
      method: "session/request_permission",
      params: {},
    };
    proxy.fromAgent(agent);
    expect(up.at(-1)).toEqual(agent);
    const answer: Message = {
      jsonrpc: "2.0",
      id: 3,
      result: { outcome: "selected" },
    };
    proxy.fromClient(answer);
    expect(down.at(-1)).toEqual(answer);
  });
});
