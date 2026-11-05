import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  usageFetchMethod,
  usageListMethod,
  usageMeasurementSchema,
  usageSourceRpcContract,
  type UsageMeasurement,
} from "./usage-contract.js";

const locatorSchema = z.tuple([z.string().min(1), z.string().min(1)]);
const CACHE_MS = 60_000;

// BB 的 provider-acp 配额源只发布 pluginId 为 provider-acp 的条目；
// 本插件注册的 provider 必须由本插件自己发布，Provider Usage 才能发现。
export function registerUsageSource(bb: BbPluginApi, providerIds: ReadonlySet<string>) {
  const cache = new Map<string, UsageMeasurement>();
  const pending = new Map<string, { refresh: boolean; promise: Promise<UsageMeasurement> }>();

  const ownedProviders = async (hostId: string) =>
    (await bb.sdk.providers.list({ hostId, capability: "usage" })).filter(provider => providerIds.has(provider.id));

  const load = async (resourceId: string, refresh: boolean): Promise<UsageMeasurement> => {
    const [hostId, providerId] = locatorSchema.parse(JSON.parse(resourceId));
    const host = (await bb.sdk.hosts.list()).find(host => host.id === hostId);
    if (!host || !(await ownedProviders(hostId)).some(provider => provider.id === providerId)) {
      throw new Error("Usage resource no longer exists.");
    }
    const previous = cache.get(resourceId);
    const unavailable = (message: string) => usageMeasurementSchema.parse({
      accountKey: previous?.accountKey ?? null,
      observedAt: previous?.observedAt ?? null,
      usage: { status: "error", accountEmail: null, planLabel: null, message },
    });
    if (host.status === "disconnected") return unavailable("Machine is disconnected.");
    if (!refresh && previous?.usage.status === "ok" && previous.observedAt !== null && Date.now() - previous.observedAt < CACHE_MS) {
      return previous;
    }
    try {
      const usage = (await bb.sdk.system.usageLimits({ hostId, providerId }))[providerId];
      if (!usage) throw new Error("Provider returned no usage information.");
      const value = usageMeasurementSchema.parse({
        accountKey: null,
        observedAt: usage.status === "ok" ? Date.now() : (previous?.observedAt ?? null),
        usage: {
          ...usage,
          plan: null,
          ...(usage.status === "ok"
            ? { windows: usage.windows.map((window, index) => ({ kind: "custom", model: null, cost: null, ...window, id: `${index}:${window.label}` })) }
            : {}),
        },
      });
      cache.set(resourceId, value);
      return value;
    } catch {
      return unavailable("Usage could not be collected from this machine.");
    }
  };

  const collect = async (resourceId: string, refresh: boolean): Promise<UsageMeasurement> => {
    const running = pending.get(resourceId);
    if (running) {
      if (!refresh || running.refresh) return running.promise;
      await running.promise.catch(() => undefined);
      return collect(resourceId, refresh);
    }
    const promise = load(resourceId, refresh).finally(() => pending.delete(resourceId));
    pending.set(resourceId, { refresh, promise });
    return promise;
  };

  bb.rpc.register(
    usageSourceRpcContract,
    {
      async [usageListMethod]() {
        const hosts = (await bb.sdk.hosts.list()).filter(host => host.type !== "ephemeral");
        const resources = (await Promise.all(hosts.map(async host =>
          (await ownedProviders(host.id).catch(() => [])).map(provider => {
            const id = JSON.stringify([host.id, provider.id]);
            return {
              id,
              accountKey: cache.get(id)?.accountKey ?? null,
              providerId: provider.id,
              label: provider.displayName,
              scope: { kind: "host" as const, hostId: host.id, hostName: host.name },
            };
          })))).flat();
        const ids = new Set(resources.map(resource => resource.id));
        for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
        return { resources };
      },
      [usageFetchMethod]: ({ resourceId, refresh }) => collect(resourceId, refresh),
    },
    {
      experimental_discoverable: true,
      experimental_description: "Host-local usage for CodexL, Kiro and AGY, owned by the local-providers plugin.",
    },
  );
}
