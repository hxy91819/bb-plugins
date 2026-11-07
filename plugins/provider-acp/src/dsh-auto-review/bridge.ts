import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  experimental_defineProviderBridge,
  threadStartParamsSchema,
  threadResumeParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type ProviderBridgeEntry,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { selectorSource } from "./selector.js";

const executionSchemas = new Map<
  string,
  | typeof threadStartParamsSchema
  | typeof threadResumeParamsSchema
  | typeof turnStartParamsSchema
  | typeof turnSteerParamsSchema
>(
  Object.entries({
    "thread/start": threadStartParamsSchema,
    "thread/resume": threadResumeParamsSchema,
    "turn/start": turnStartParamsSchema,
    "turn/steer": turnSteerParamsSchema,
  }),
);

function writeAtomic(path: string, content: string): void {
  const temporary = path + "." + randomUUID();
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function withDshAutoReview(
  delegate: ProviderBridgeEntry,
): ProviderBridgeEntry {
  const io = createBridgeIo();
  let overlay: string;
  return experimental_defineProviderBridge({
    ...delegate,
    start(context) {
      mkdirSync(context.dataDir, { recursive: true });
      const selector = join(context.dataDir, "dsh-auto-review.mjs");
      overlay = join(context.dataDir, "dsh-auto-review.yml");
      writeAtomic(selector, selectorSource);
      writeAtomic(
        overlay,
        JSON.stringify([
          {
            insert: [
              {
                id: "bb-auto-review",
                name: "@deepseek-ai/dsh-experimental-auto-review",
              },
              { id: "bb-auto-review-selector", name: selector },
            ],
          },
        ]),
      );
      delegate.start?.(context);
    },
    handleLine(line) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        delegate.handleLine(line);
        return;
      }
      const request = bridgeRequestEnvelopeSchema.safeParse(raw);
      if (!request.success) {
        delegate.handleLine(line);
        return;
      }
      const schema = executionSchemas.get(request.data.method);
      if (!schema) {
        delegate.handleLine(line);
        return;
      }
      const parsed = schema.safeParse(request.data.params);
      if (!parsed.success) {
        delegate.handleLine(line);
        return;
      }
      if (parsed.data.options.providerOptions?.dshNativeAutoReview !== true) {
        delegate.handleLine(line);
        return;
      }
      const launch = experimental_acpLaunchSpecSchema.safeParse(
        parsed.data.options.providerOptions?.acpLaunchSpec,
      );
      if (!launch.success || !overlay) {
        io.sendError(
          request.data.id,
          -32602,
          "DSH Auto Review requires an initialized ACP launch.",
        );
        return;
      }
      const mode = parsed.data.options.permissionMode;
      const preset =
        mode === "auto"
          ? "auto"
          : mode === "full"
            ? "danger-full-access"
            : "workspace-write";
      delegate.handleLine(
        JSON.stringify({
          ...request.data,
          params: {
            ...parsed.data,
            options: {
              ...parsed.data.options,
              ...(mode === "auto"
                ? { permissionMode: "accept-edits", approvalReviewer: "user" }
                : {}),
              envVars: {
                ...parsed.data.options.envVars,
                BB_DSH_PERMISSION_PRESET: preset,
              },
              providerOptions: {
                ...parsed.data.options.providerOptions,
                acpLaunchSpec: {
                  ...launch.data,
                  args: [...launch.data.args, "--patch", overlay],
                },
              },
            },
          },
        }),
      );
    },
  });
}
