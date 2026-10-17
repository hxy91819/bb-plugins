import type { AcpAgentDefinition } from "./agents.js";
import type { AcpAgentProbe } from "@get-bb/plugin-sdk/provider-bridge/acp";

export interface AcpProbeApplication {
  agent: AcpAgentDefinition;
  reason: string;
}

export function applyAcpAgentProbe(
  agent: AcpAgentDefinition,
  probe: AcpAgentProbe,
): AcpProbeApplication | null {
  if (!probe.reachable) {
    return null;
  }
  const fork = !probe.fork
    ? "none"
    : agent.fork !== "tip" &&
        (probe.checkpointFork === true ||
          (probe.checkpointFork === undefined && agent.fork === "checkpoint"))
      ? "checkpoint"
      : "tip";
  if (agent.fork === "none" || agent.fork === fork) {
    return null;
  }
  return {
    agent: { ...agent, fork },
    reason:
      fork === "checkpoint"
        ? "the agent supports checkpoint forks"
        : probe.fork
          ? "the agent advertises session/fork"
          : "the agent does not advertise session/fork",
  };
}
