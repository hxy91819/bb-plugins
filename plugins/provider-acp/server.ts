import { registerUsageSource } from "./src/usage-source.js";
import type {
  BbPluginApi,
  PluginProviderDeclaration,
} from "@get-bb/plugin-sdk";
import type { AcpAgentProbe } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { z } from "zod";
import { type AcpAgentDefinition } from "./src/agents.js";
import { resolveConfiguredAcpAgents } from "./src/configured-agents.js";
import { acpHostContract } from "./src/contract.js";
import { acpProviderDeclaration } from "./src/declaration.js";
import { applyAcpAgentProbe } from "./src/probe-capabilities.js";
import {
  KNOWN_ACP_AGENTS,
  RESERVED_ACP_PROVIDER_IDS,
} from "./src/known-agents.js";

const CUSTOM_AGENTS_SETTING_DESCRIPTION =
  "A JSON array of ACP agents to add. Each entry needs id, displayName and command; see the guide for the optional fields.";

const HOST_POLL_INTERVAL_MS = 5_000;

function probeKey(agent: AcpAgentDefinition): string {
  return JSON.stringify({
    command: agent.launch.command,
    args: agent.launch.args,
    env: agent.launch.env,
    cwd: agent.launch.cwd,
    fork: agent.fork,
  });
}

async function sleepUntilAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}

export default async function acpProvidersPlugin(
  bb: BbPluginApi,
): Promise<void> {
  registerUsageSource(bb);
  const host = bb.hosts.experimental_client({ contract: acpHostContract });
  const settings = bb.settings.define({
    customAgents: {
      type: "string",
      label: "Custom agents",
      description: CUSTOM_AGENTS_SETTING_DESCRIPTION,
      experimental_multiline: true,
      experimental_schema: z.string().superRefine((value, context) => {
        const { warnings } = resolveConfiguredAcpAgents({
          settingValue: value,
          reservedProviderIds: RESERVED_ACP_PROVIDER_IDS,
          shippedAgents: KNOWN_ACP_AGENTS,
        });
        const errors = warnings.map((warning) => {
          if (warning.includes("not valid JSON")) {
            return "Custom agents must be valid JSON.";
          }
          if (warning.includes("must be a JSON array")) {
            return "Custom agents must be a JSON array.";
          }
          return warning.replace(/^ACP custom agent setting: /u, "");
        });
        if (errors.length > 0) {
          context.addIssue({ code: "custom", message: errors.join(" ") });
        }
      }),
      default: "",
    },
  });

  const registered = new Map<string, { key: string; dispose(): void }>();

  const probesByHost = new Map<
    string,
    Map<string, { key: string; probe: AcpAgentProbe }>
  >();
  let configuredAgents: readonly AcpAgentDefinition[] = [];
  let configurationRevision = 0;

  function declaredAgents(): AcpAgentDefinition[] {
    const configuredIds = new Set(configuredAgents.map((agent) => agent.id));
    return [
      ...KNOWN_ACP_AGENTS.filter((agent) => !configuredIds.has(agent.id)),
      ...configuredAgents,
    ];
  }

  function desiredAgents(): AcpAgentDefinition[] {
    return declaredAgents().map((agent) => {
      const key = probeKey(agent);
      const probes = [...probesByHost.values()].flatMap((byAgent) => {
        const record = byAgent.get(agent.id);
        return record?.key === key && record.probe.reachable
          ? [record.probe]
          : [];
      });
      const probe =
        (agent.fork === undefined
          ? (probes.find(
              (probe) => probe.fork && probe.checkpointFork === true,
            ) ?? probes.find((probe) => probe.fork))
          : probes.find(
              (probe) =>
                !probe.fork ||
                (agent.fork === "checkpoint" && probe.checkpointFork === false),
            )) ?? probes[0];
      return probe ? (applyAcpAgentProbe(agent, probe)?.agent ?? agent) : agent;
    });
  }

  function register(declaration: PluginProviderDeclaration): void {
    try {
      const { dispose } = bb.providers.register(declaration);
      registered.set(declaration.id, {
        key: JSON.stringify(declaration),
        dispose,
      });
    } catch (error) {
      bb.log.error(
        `Could not register ACP provider "${declaration.id}": ${String(error)}`,
      );
    }
  }

  function reconcile(agents: readonly AcpAgentDefinition[]): void {
    const desired = new Map(
      agents.map((agent) => [agent.id, acpProviderDeclaration(agent)]),
    );
    for (const [id, entry] of [...registered]) {
      const next = desired.get(id);
      if (next !== undefined && JSON.stringify(next) === entry.key) {
        continue;
      }
      entry.dispose();
      registered.delete(id);
    }
    for (const [id, declaration] of desired) {
      if (registered.has(id)) {
        continue;
      }
      register(declaration);
    }
  }

  function resolveAndReconcile(settingValue: string): void {
    const resolved = resolveConfiguredAcpAgents({
      settingValue,
      reservedProviderIds: RESERVED_ACP_PROVIDER_IDS,
      shippedAgents: KNOWN_ACP_AGENTS,
    });
    for (const warning of resolved.warnings) {
      bb.log.warn(warning);
    }
    if (JSON.stringify(configuredAgents) !== JSON.stringify(resolved.agents)) {
      configurationRevision += 1;
    }
    configuredAgents = resolved.agents;
    const keys = new Map(
      declaredAgents().map((agent) => [agent.id, probeKey(agent)]),
    );
    for (const byAgent of probesByHost.values()) {
      for (const [id, record] of byAgent) {
        if (keys.get(id) !== record.key) byAgent.delete(id);
      }
    }
    reconcile(desiredAgents());
    if (resolved.agents.length > 0) {
      bb.log.info(
        `Registered ${resolved.agents.length} configured ACP agent(s).`,
      );
    }
  }

  let pending: Promise<void> = Promise.resolve();
  function queueReconcile(settingValue: string): Promise<void> {
    pending = pending
      .catch(() => undefined)
      .then(() => resolveAndReconcile(settingValue));
    return pending;
  }

  async function probeAgents(
    hostId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const revision = configurationRevision;
    const agents = declaredAgents();
    const disabledIds = new Set(
      (await bb.sdk.providers.catalog())
        .filter((provider) => !provider.enabled)
        .map((provider) => provider.id),
    );
    const byAgent =
      probesByHost.get(hostId) ??
      new Map<string, { key: string; probe: AcpAgentProbe }>();
    probesByHost.set(hostId, byAgent);
    for (const agent of agents) {
      if (signal.aborted || revision !== configurationRevision) return;
      if (agent.fork === "none" || disabledIds.has(agent.id)) continue;
      const key = probeKey(agent);
      if (byAgent.get(agent.id)?.key === key) continue;
      let probe: AcpAgentProbe;
      try {
        probe = await host.call(
          "probeAgent",
          {
            command: agent.launch.command,
            args: agent.launch.args,
            env: agent.launch.env,
            ...(agent.launch.cwd === undefined
              ? {}
              : { cwd: agent.launch.cwd }),
          },
          { hostId, signal },
        );
      } catch (error) {
        bb.log.debug(
          `Could not probe ${agent.id} on host ${hostId}: ${String(error)}`,
        );
        probe = { reachable: false, reason: String(error) };
      }
      if (signal.aborted || revision !== configurationRevision) return;
      byAgent.set(agent.id, { key, probe });
      const applied = applyAcpAgentProbe(agent, probe);
      if (applied !== null) {
        bb.log.info(
          `${agent.id} on host ${hostId}: ${applied.reason}; re-registering.`,
        );
      }
      reconcile(desiredAgents());
    }
  }

  for (const agent of desiredAgents()) {
    register(acpProviderDeclaration(agent));
  }

  const initial = await settings.get();
  await queueReconcile(initial.customAgents);
  settings.onChange((next) => {
    void queueReconcile(next.customAgents).catch((error: unknown) => {
      bb.log.error(
        `Could not re-register the configured ACP agents: ${String(error)}`,
      );
    });
  });

  bb.background.service("acp-capability-probe", {
    async start(signal: AbortSignal): Promise<void> {
      while (!signal.aborted) {
        const hosts = await bb.sdk.hosts.list();
        const connected = new Set(
          hosts
            .filter((available) => available.status === "connected")
            .map((available) => available.id),
        );
        let removed = false;
        for (const hostId of probesByHost.keys()) {
          if (!connected.has(hostId)) {
            probesByHost.delete(hostId);
            removed = true;
          }
        }
        if (removed) reconcile(desiredAgents());
        for (const hostId of connected) {
          if (signal.aborted) break;
          await probeAgents(hostId, signal);
        }
        if (signal.aborted) break;
        await sleepUntilAbort(HOST_POLL_INTERVAL_MS, signal);
      }
    },
  });

  bb.onDispose(() => {
    for (const [, entry] of registered) {
      entry.dispose();
    }
    registered.clear();
  });
}
