import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  experimental_defineProviderBridge,
  threadStartParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { withDshAutoReview } from "../src/bridge.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it.each(["thread/start", "thread/resume", "turn/start", "turn/steer"])(
  "keeps native review and human approval on %s",
  (method) => {
    const root = mkdtempSync(join(tmpdir(), "dsh-bridge-"));
    roots.push(root);
    const receive = vi.fn();
    const bridge = withDshAutoReview(
      experimental_defineProviderBridge({ handleLine: receive }),
    );
    bridge.start?.({
      pluginId: "dsh-auto-review",
      dataDir: root,
      tempDir: root,
    });
    const params = {
      threadId: "thr_test",
      providerThreadId: "session-test",
      expectedTurnId: "turn-test",
      cwd: root,
      instructionMode: "append",
      input: [{ type: "text", text: "write an authorized marker" }],
      clientRequestId: "creq_23456789ab",
      options: {
        permissionMode: "auto",
        permissionScope: "workspace",
        approvalReviewer: "automatic",
        permissionEscalation: "ask",
        model: "model-test",
        providerOptions: {
          acpLaunchSpec: {
            displayName: "DSH",
            command: "dsh",
            args: ["--profile", "acp"],
            env: {},
          },
        },
      },
    };
    bridge.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    );
    expect(receive).toHaveBeenCalledOnce();
    const forwarded = JSON.parse(receive.mock.calls[0][0]);
    expect(forwarded.params.options).toMatchObject({
      permissionMode: "accept-edits",
      approvalReviewer: "user",
      model: "model-test",
    });
    expect(forwarded.params.options.providerOptions.acpLaunchSpec.args).toEqual(
      ["--profile", "acp", "--patch", join(root, "dsh-auto-review.yml")],
    );
    if (method === "thread/start")
      expect(threadStartParamsSchema.safeParse(forwarded.params).success).toBe(
        true,
      );
  },
);

it("rejects Full access rather than bypassing DSH review", () => {
  const receive = vi.fn();
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const bridge = withDshAutoReview(
    experimental_defineProviderBridge({ handleLine: receive }),
  );
  bridge.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "thread/start",
      params: {
        threadId: "thr_test",
        cwd: "/tmp",
        instructionMode: "append",
        options: {
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        },
      },
    }),
  );
  expect(receive).not.toHaveBeenCalled();
  expect(JSON.parse(String(output.mock.calls[0][0])).error.message).toContain(
    "requires permission mode auto",
  );
});
