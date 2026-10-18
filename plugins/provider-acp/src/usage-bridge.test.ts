import { describe, expect, it } from "vitest";
import { withAgyUsage } from "./usage-bridge.js";
import { usageError } from "./agy-usage.js";

const params = (binary = "/fixture/agy") => ({
  providerId: "acp-renamed-agent",
  providerOptions: {
    acpDialect: "agy",
    acpLaunchSpec: {
      displayName: "Agent",
      command: "adapter",
      args: [],
      env: { AGY_BIN: binary },
    },
  },
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("AGY maintenance alongside standard ACP", () => {
  it("uses BB launch configuration, shares identical reads, and delegates other requests unchanged", async () => {
    const forwarded: string[] = [],
      output: any[] = [],
      reads: any[] = [];
    const bridge = withAgyUsage(
      {
        experimental_apiVersion: 1,
        handleLine: (line) => {
          forwarded.push(line);
        },
      },
      async (command, options) => {
        reads.push({ command, cwd: options.cwd, env: options.env });
        return usageError("fixture");
      },
      (line) => output.push(JSON.parse(line)),
    );
    const send = (id: number, method: string, input: unknown) =>
      bridge.handleLine(
        JSON.stringify({ jsonrpc: "2.0", id, method, params: input }),
      );
    send(1, "provider/usage", { ...params(), cwd: "/fixture/work" });
    send(2, "provider/usage", { ...params(), cwd: "/fixture/work" });
    send(3, "provider/usage", params("/other/agy"));
    send(4, "thread/resume", { providerThreadId: "preserved" });
    send(5, "provider/usage", {
      providerId: "acp-cursor-sdk",
      providerOptions: { acpDialect: "cursor" },
    });
    send(6, "provider/usage", {
      providerId: "acp-agent",
      providerOptions: { acpDialect: "agy" },
    });
    await tick();
    expect(reads).toEqual([
      {
        command: "/fixture/agy",
        cwd: "/fixture/work",
        env: { AGY_BIN: "/fixture/agy" },
      },
      { command: "/other/agy", cwd: undefined, env: { AGY_BIN: "/other/agy" } },
    ]);
    expect(output.filter((reply) => reply.result)).toHaveLength(3);
    expect(output.find((reply) => reply.id === 6).error.code).toBe(-32602);
    expect(forwarded.map((line) => JSON.parse(line).id)).toEqual([4, 5]);
  });
  it("waits for a cancelled quota subprocess before delegating shutdown", async () => {
    const events: string[] = [];
    const bridge = withAgyUsage(
      {
        experimental_apiVersion: 1,
        handleLine() {},
        onClose() {
          events.push("closed");
        },
      },
      async (_command, options) => {
        await new Promise<void>((resolve) =>
          options.signal!.addEventListener(
            "abort",
            () =>
              setImmediate(() => {
                events.push("cleaned");
                resolve();
              }),
            { once: true },
          ),
        );
        return usageError("cancelled");
      },
      () => {},
    );
    bridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "provider/usage",
        params: params(),
      }),
    );
    await tick();
    bridge.onClose?.();
    await tick();
    await tick();
    expect(events).toEqual(["cleaned", "closed"]);
  });
});
