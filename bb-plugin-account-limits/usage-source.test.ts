import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { usageFetchMethod, usageListMethod } from "./usage-contract.js";
import { registerUsageSource } from "./usage-source.js";

function fakeBb() {
  const handlers: Record<string, (input: any) => Promise<any>> = {};
  let registration: { experimental_discoverable?: boolean } | undefined;
  const bb = {
    sdk: {
      hosts: { list: async () => [{ id: "h1", name: "Host", status: "connected", type: "persistent" }] },
      providers: {
        list: async () => [
          { id: "acp-kiro", displayName: "Kiro", pluginId: "account-limits" },
          { id: "acp-copilot", displayName: "GitHub Copilot", pluginId: "account-limits" },
          { id: "acp-cursor", displayName: "Cursor", pluginId: "provider-acp" },
        ],
      },
      system: {
        usageLimits: async ({ providerId }: { providerId: string }) => ({
          [providerId]: { status: "ok", accountEmail: null, planLabel: "PRO", windows: [{ label: "Plan credits", usedPercent: 40, resetsAt: null }] },
        }),
      },
    },
    rpc: {
      register(_contract: unknown, h: typeof handlers, options: typeof registration) {
        Object.assign(handlers, h);
        registration = options;
      },
    },
  } as unknown as BbPluginApi;
  return { bb, handlers, registration: () => registration };
}

test("Provider Usage discovers this plugin's own usage providers and reads their limits", async () => {
  const { bb, handlers, registration } = fakeBb();
  registerUsageSource(bb, new Set(["acp-kiro", "acp-codexl"]));
  assert.equal(registration()?.experimental_discoverable, true);

  const { resources } = await handlers[usageListMethod]!({});
  assert.deepEqual(resources.map((r: { providerId: string }) => r.providerId), ["acp-kiro"]);

  const measurement = await handlers[usageFetchMethod]!({ resourceId: resources[0].id, refresh: true });
  assert.equal(measurement.usage.status, "ok");
  assert.equal(measurement.usage.planLabel, "PRO");
  assert.equal(measurement.usage.windows[0].usedPercent, 40);
});
