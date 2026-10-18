import {
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  experimental_defineProviderBridge,
  providerMaintenanceParamsSchema,
  type ProviderBridgeEntry,
  type ProviderUsageResult,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { readAgyUsage, usageError, type QueryOptions } from "./agy-usage.js";

/** ACP execution always stays in the SDK; this adds AGY's read-only maintenance command. */
export function withAgyUsage(
  delegate: ProviderBridgeEntry,
  read: (
    command: string,
    options: QueryOptions,
  ) => Promise<ProviderUsageResult> = readAgyUsage,
  write?: (line: string) => void,
): ProviderBridgeEntry {
  const io = createBridgeIo({ write });
  const controller = new AbortController();
  const pending = new Map<string, Promise<ProviderUsageResult>>();
  let closing = false;
  const close = (handler = delegate.onClose) => {
    if (closing) return;
    closing = true;
    controller.abort();
    void Promise.allSettled(pending.values()).then(() => handler?.());
  };
  return experimental_defineProviderBridge({
    ...delegate,
    handleLine(line) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        delegate.handleLine(line);
        return;
      }
      const request = bridgeRequestEnvelopeSchema.safeParse(raw);
      if (!request.success || request.data.method !== "provider/usage") {
        delegate.handleLine(line);
        return;
      }
      const params = providerMaintenanceParamsSchema.safeParse(
        request.data.params,
      );
      if (
        !params.success ||
        params.data.providerOptions?.acpDialect !== "agy"
      ) {
        delegate.handleLine(line);
        return;
      }
      const launch = experimental_acpLaunchSpecSchema.safeParse(
        params.data.providerOptions.acpLaunchSpec,
      );
      if (!launch.success) {
        io.sendError(
          request.data.id,
          -32602,
          "Invalid AGY launch configuration.",
        );
        return;
      }
      const command = launch.data.env.AGY_BIN || "agy";
      const options = {
        signal: controller.signal,
        cwd: params.data.cwd ?? launch.data.cwd,
        env: launch.data.env,
      };
      const key = JSON.stringify([command, options.cwd, options.env]);
      let query = pending.get(key);
      if (!query) {
        query = Promise.resolve()
          .then(() => read(command, options))
          .catch(() => usageError("AGY usage could not be collected."));
        pending.set(key, query);
        void query.finally(() => pending.delete(key));
      }
      void query.then((result) => io.sendResult(request.data.id, result));
    },
    onClose() {
      close();
    },
    onSigterm() {
      close(delegate.onSigterm ?? delegate.onClose);
    },
    onSigint() {
      close(delegate.onSigint ?? delegate.onClose);
    },
  });
}
