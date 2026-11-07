import { mkdirSync, writeFileSync } from "node:fs";
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
      writeFileSync(selector, selectorSource, { mode: 0o600 });
      writeFileSync(
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
        { mode: 0o600 },
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
      if (parsed.data.options.permissionMode !== "auto") {
        io.sendError(
          request.data.id,
          -32602,
          "DSH Auto Review requires permission mode auto.",
        );
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
      delegate.handleLine(
        JSON.stringify({
          ...request.data,
          params: {
            ...parsed.data,
            options: {
              ...parsed.data.options,
              permissionMode: "accept-edits",
              approvalReviewer: "user",
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
