import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  experimental_defineProviderBridge,
  threadStartParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { withDshAutoReview } from "./bridge.js";

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
          dshNativeAutoReview: true,
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

it.each(["full", "auto"])(
  "preserves other-provider traffic for mode %s",
  (mode) => {
    const receive = vi.fn();
    const bridge = withDshAutoReview(
      experimental_defineProviderBridge({ handleLine: receive }),
    );
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "thread/start",
      params: {
        threadId: "thr_test",
        cwd: "/tmp",
        instructionMode: "append",
        options:
          mode === "full"
            ? {
                permissionMode: "full",
                permissionScope: "full",
                approvalReviewer: null,
                permissionEscalation: null,
              }
            : {
                permissionMode: "auto",
                permissionScope: "workspace",
                approvalReviewer: "automatic",
                permissionEscalation: "ask",
              },
      },
    });
    bridge.handleLine(request);
    expect(receive).toHaveBeenCalledWith(request);
  },
);

it.each([
  {
    mode: "auto",
    preset: "auto",
    reviewer: "user",
    scope: "workspace",
    escalation: "ask",
    internalMode: "accept-edits",
  },
  {
    mode: "full",
    preset: "danger-full-access",
    reviewer: null,
    scope: "full",
    escalation: null,
    internalMode: "full",
  },
  {
    mode: "accept-edits",
    preset: "workspace-write",
    reviewer: "user",
    scope: "workspace",
    escalation: "ask",
    internalMode: "accept-edits",
  },
])(
  "pins native $mode into the restart-sensitive environment",
  ({ mode, preset, reviewer, scope, escalation, internalMode }) => {
    const root = mkdtempSync(join(tmpdir(), "dsh-mode-"));
    roots.push(root);
    const receive = vi.fn();
    const bridge = withDshAutoReview(
      experimental_defineProviderBridge({ handleLine: receive }),
    );
    bridge.start?.({ pluginId: "test", dataDir: root, tempDir: root });
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "thread/start",
      params: {
        threadId: "thr_test",
        cwd: root,
        instructionMode: "append",
        options: {
          permissionMode: mode,
          permissionScope: scope,
          approvalReviewer: mode === "auto" ? "automatic" : reviewer,
          permissionEscalation: escalation,
          providerOptions: {
            dshNativeAutoReview: true,
            acpLaunchSpec: {
              displayName: "DSH",
              command: "dsh",
              args: ["--profile", "acp"],
              env: {},
            },
          },
        },
      },
    };
    bridge.handleLine(JSON.stringify(request));
    const forwarded = JSON.parse(receive.mock.calls[0][0]);
    expect(forwarded.params.options).toMatchObject({
      permissionMode: internalMode,
      approvalReviewer: reviewer,
      envVars: { BB_DSH_PERMISSION_PRESET: preset },
    });
    expect(
      forwarded.params.options.providerOptions.acpLaunchSpec.args,
    ).toContain(join(root, "dsh-auto-review.yml"));
    expect(threadStartParamsSchema.safeParse(forwarded.params).success).toBe(
      true,
    );
  },
);
