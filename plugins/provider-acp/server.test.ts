import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import { KNOWN_ACP_AGENTS } from "./src/known-agents.js";
import acpProvidersPlugin from "./server.js";
import type { AcpAgentProbe } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import acpHostEntry from "./src/host.js";
import { acpHostContract } from "./src/contract.js";

const PLUGIN_ID = "provider-acp";

const DECLARED_ICON_NAMES = Object.keys(
  z
    .object({
      bb: z.object({
        branding: z.object({
          experimental_icons: z.record(z.string(), z.string()),
        }),
      }),
    })
    .parse(
      JSON.parse(
        readFileSync(new URL("./package.json", import.meta.url), "utf8"),
      ),
    ).bb.branding.experimental_icons,
);

function customAgents(...agents: unknown[]): string {
  return JSON.stringify(agents);
}

function forkOf(
  host: ReturnType<typeof createFakePluginHost>,
  providerId: string,
): string | undefined {
  return host.harness.registrations.providerRegistrations.find(
    (declaration) => declaration.id === providerId,
  )?.capabilities.fork;
}

function registeredIds(
  host: ReturnType<typeof createFakePluginHost>,
): string[] {
  return host.harness.registrations.providerRegistrations.map(
    (declaration) => declaration.id,
  );
}

async function loadPlugin(options: {
  customAgents?: string;
  probe?: (
    command: string,
    hostId: string,
    input: z.infer<typeof acpHostContract.probeAgent.input>,
  ) => unknown;
  hosts?: { id: string; status: string }[];
}) {
  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    experimental_declaredIconNames: DECLARED_ICON_NAMES,
    ...(options.customAgents === undefined
      ? {}
      : { settings: { customAgents: options.customAgents } }),
    ...(options.probe === undefined
      ? {}
      : {
          experimental_callHostRpc: (call: {
            input: unknown;
            hostId: string;
          }) => {
            const input = acpHostContract.probeAgent.input.parse(call.input);
            return options.probe?.(input.command, call.hostId, input) as never;
          },
        }),
  });
  host.harness.sdk.stub("hosts.list", () =>
    Promise.resolve(options.hosts ?? []),
  );
  host.harness.sdk.stub("providers.catalog", () => Promise.resolve([]));
  await acpProvidersPlugin(host.bb);
  return host;
}

describe("the ACP plugin's registrations", () => {
  it("updates a custom provider's tip fork declaration when settings change", async () => {
    const entry = {
      id: "cursor-sdk",
      displayName: "Cursor SDK",
      command: "cursor-acp",
    };
    const host = await loadPlugin({ customAgents: customAgents(entry) });
    expect(forkOf(host, "acp-cursor-sdk")).toBe("none");
    await host.harness.setSettings({
      customAgents: customAgents({ ...entry, fork: "tip" }),
    });
    await vi.waitFor(() => expect(forkOf(host, "acp-cursor-sdk")).toBe("tip"));
    expect(forkOf(host, "acp-cursor")).toBe("none");
    await host.harness.setSettings({ customAgents: customAgents(entry) });
    await vi.waitFor(() => expect(forkOf(host, "acp-cursor-sdk")).toBe("none"));
  });

  it("registers every shipped agent, and a configured one beside them", async () => {
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "amp",
        displayName: "Amp",
        command: "amp",
      }),
    });

    expect(registeredIds(host)).toContain("acp-cursor");
    expect(registeredIds(host)).toContain("acp-amp");
  });

  it("registers a custom agent with a declared plugin icon and tint", async () => {
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "cursor-sdk",
        displayName: "Cursor (SDK)",
        command: "node",
        icon: "provider-acp/cursor",
        iconTint: { light: "#111827", dark: "#F5F5F5" },
      }),
    });

    const declaration = host.harness.registrations.providerRegistrations.find(
      (provider) => provider.id === "acp-cursor-sdk",
    );
    expect(declaration?.icon).toBe("provider-acp/cursor");
    expect(declaration?.strings?.iconTint).toEqual({
      light: "#111827",
      dark: "#F5F5F5",
    });
  });

  it("updates the custom fork declaration when its setting changes", async () => {
    const agent = { id: "amp", displayName: "Amp", command: "amp-acp" };
    const host = await loadPlugin({ customAgents: customAgents(agent) });
    expect(forkOf(host, "acp-amp")).toBe("none");
    await host.harness.setSettings({
      customAgents: customAgents({ ...agent, fork: "tip" }),
    });
    await vi.waitFor(() => expect(forkOf(host, "acp-amp")).toBe("tip"));
    await host.harness.setSettings({
      customAgents: customAgents({ ...agent, fork: "none" }),
    });
    await vi.waitFor(() => expect(forkOf(host, "acp-amp")).toBe("none"));
  });

  it("removes a configured agent the setting no longer lists", async () => {
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "amp",
        displayName: "Amp",
        command: "amp",
      }),
    });
    expect(registeredIds(host)).toContain("acp-amp");

    await host.harness.setSettings({ customAgents: "[]" });

    await vi.waitFor(() =>
      expect(registeredIds(host)).not.toContain("acp-amp"),
    );
    expect(registeredIds(host)).toContain("acp-cursor");
  });

  it("keeps the rest of the list when one entry is malformed", async () => {
    const host = await loadPlugin({
      customAgents: customAgents(
        { id: "Bad Slug", displayName: "x", command: "x" },
        { id: "amp", displayName: "Amp", command: "amp" },
      ),
    });

    expect(registeredIds(host)).toContain("acp-amp");
    expect(
      host.harness.logEntries.some((entry) =>
        entry.message.includes("is not a valid agent"),
      ),
    ).toBe(true);
  });
});

describe("the ACP plugin's registration bookkeeping", () => {
  it("registers the shipped agents before the factory's first await", async () => {
    const host = createFakePluginHost({
      pluginId: PLUGIN_ID,
      experimental_declaredIconNames: DECLARED_ICON_NAMES,
    });
    host.harness.sdk.stub("hosts.list", () => Promise.resolve([]));

    const loading = acpProvidersPlugin(host.bb);
    expect(registeredIds(host)).toContain("acp-cursor");
    await loading;
  });

  it("restores the shipped agent when its override is removed", async () => {
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "opencode",
        displayName: "My opencode",
        command: "/opt/opencode",
      }),
    });
    const override = host.harness.registrations.providerRegistrations.find(
      (declaration) => declaration.id === "acp-opencode",
    );
    expect(override?.displayName).toBe("My opencode");
    expect(override?.experimental_nativeSkillRoots?.project).toHaveLength(3);
    expect(override?.experimental_resolvesNativeRoots).toBe(true);

    await host.harness.setSettings({ customAgents: "[]" });

    await vi.waitFor(() => {
      const opencode = host.harness.registrations.providerRegistrations.filter(
        (declaration) => declaration.id === "acp-opencode",
      );
      expect(opencode).toHaveLength(1);
      expect(opencode[0]?.displayName).toBe("opencode");
    });
  });

  it("keeps an untouched agent's registration identical across a save", async () => {
    const host = await loadPlugin({ customAgents: "[]" });
    const idsBefore = registeredIds(host);
    const before = host.harness.registrations.providerRegistrations.find(
      (declaration) => declaration.id === "acp-cursor",
    );

    await host.harness.setSettings({
      customAgents: customAgents({
        id: "amp",
        displayName: "Amp",
        command: "amp",
      }),
    });
    await vi.waitFor(() =>
      expect(registeredIds(host)).toEqual([...idsBefore, "acp-amp"]),
    );

    expect(
      host.harness.registrations.providerRegistrations.find(
        (declaration) => declaration.id === "acp-cursor",
      ),
    ).toBe(before);
  });

  it("serializes overlapping settings changes into one consistent state", async () => {
    const host = await loadPlugin({ customAgents: "[]" });
    const cursorBefore = host.harness.registrations.providerRegistrations.find(
      (declaration) => declaration.id === "acp-cursor",
    );

    await Promise.all([
      host.harness.setSettings({
        customAgents: customAgents({
          id: "amp",
          displayName: "Amp",
          command: "amp",
        }),
      }),
      host.harness.setSettings({
        customAgents: customAgents({
          id: "amp",
          displayName: "Amp",
          command: "amp",
        }),
      }),
    ]);

    await vi.waitFor(() => expect(registeredIds(host)).toContain("acp-amp"));
    expect(registeredIds(host).filter((id) => id === "acp-amp")).toHaveLength(
      1,
    );
    expect(
      host.harness.registrations.providerRegistrations.find(
        (declaration) => declaration.id === "acp-cursor",
      ),
    ).toBe(cursorBefore);
  });
});

describe("the ACP plugin's capability probe", () => {
  it.each([
    { configured: undefined, checkpointFork: true, expected: "checkpoint" },
    { configured: "checkpoint", checkpointFork: true, expected: "checkpoint" },
    { configured: "tip", checkpointFork: true, expected: "tip" },
    { configured: "none", checkpointFork: true, expected: "none" },
    { configured: "checkpoint", checkpointFork: false, expected: "tip" },
    {
      configured: "checkpoint",
      checkpointFork: undefined,
      expected: "checkpoint",
    },
    { configured: undefined, checkpointFork: undefined, expected: "tip" },
  ])(
    "registers the supported fork boundary for %j",
    async ({ configured, checkpointFork, expected }) => {
      const host = await loadPlugin({
        customAgents: customAgents({
          id: "cursor-sdk",
          displayName: "Cursor SDK",
          command: "cursor-acp",
          ...(configured === undefined ? {} : { fork: configured }),
        }),
        hosts: [{ id: "host_1", status: "connected" }],
        probe: () => ({
          reachable: true,
          fork: true,
          ...(checkpointFork === undefined ? {} : { checkpointFork }),
        }),
      });
      vi.useFakeTimers();
      const run = host.harness.runService("acp-capability-probe");
      try {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(forkOf(host, "acp-cursor-sdk")).toBe(expected);
      } finally {
        run.controller.abort();
        await run.done;
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { customCwd: false, checkpoint: false },
    { customCwd: true, checkpoint: false },
    { customCwd: false, checkpoint: true },
    { customCwd: true, checkpoint: true },
  ])(
    "discovers custom fork boundaries through a real ACP initialize response (%j)",
    async ({ customCwd, checkpoint }) => {
      const fixtureDir = await mkdtemp(path.join(tmpdir(), "bb-auto-fork-"));
      const cwd = customCwd ? path.join(fixtureDir, "agent") : fixtureDir;
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(cwd, "fork-marker"), "fixture");
      const hostEntry = experimental_createHostEntryHarness(acpHostEntry, {
        experimental_paths: { dataDir: fixtureDir, tempDir: fixtureDir },
      });
      const args = [
        "-e",
        `
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        input += chunk;
        let end;
        while ((end = input.indexOf("\\n")) >= 0) {
          const request = JSON.parse(input.slice(0, end));
          input = input.slice(end + 1);
          if (request.method === "initialize") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0", id: request.id,
              result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities:
                require("node:fs").existsSync("fork-marker") ? { fork: ${JSON.stringify(checkpoint ? { _meta: { "cursor-acp/checkpoint": true } } : {})} } : {} } },
            }) + "\\n");
          }
        }
      });
    `,
      ];
      const host = await loadPlugin({
        customAgents: customAgents({
          id: "fixture",
          displayName: "Fixture",
          command: process.execPath,
          args,
          ...(customCwd ? { cwd } : {}),
        }),
        hosts: [{ id: "host_1", status: "connected" }],
        probe: (command, _hostId, input) =>
          command === process.execPath
            ? hostEntry.experimental_call("probeAgent", input)
            : { reachable: false, reason: "not installed" },
      });
      expect(forkOf(host, "acp-fixture")).toBe("none");
      const run = host.harness.runService("acp-capability-probe");
      try {
        await vi.waitFor(
          () =>
            expect(forkOf(host, "acp-fixture")).toBe(
              checkpoint ? "checkpoint" : "tip",
            ),
          {
            timeout: 5_000,
          },
        );
      } finally {
        run.controller.abort();
        await run.done;
        await hostEntry.experimental_dispose();
        await rm(fixtureDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { reachable: true, fork: false },
    { reachable: false, reason: "not installed" },
  ])(
    "leaves an automatically detected custom fork unavailable for %j",
    async (probe) => {
      const host = await loadPlugin({
        customAgents: customAgents({
          id: "amp",
          displayName: "Amp",
          command: "amp-acp",
        }),
        hosts: [{ id: "host_1", status: "connected" }],
        probe: () => probe,
      });
      const run = host.harness.runService("acp-capability-probe");
      try {
        await vi.waitFor(() =>
          expect(
            host.harness.experimental_hostRpcCalls.some(
              (call) =>
                (call.input as { command: string }).command === "amp-acp",
            ),
          ).toBe(true),
        );
        expect(forkOf(host, "acp-amp")).toBe("none");
      } finally {
        run.controller.abort();
        await run.done;
      }
    },
  );

  it("honors an explicit none override without probing the custom agent", async () => {
    const probed: string[] = [];
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "amp",
        displayName: "Amp",
        command: "amp-acp",
        fork: "none",
      }),
      hosts: [{ id: "host_1", status: "connected" }],
      probe: (command) => {
        probed.push(command);
        return { reachable: true, fork: true };
      },
    });
    const run = host.harness.runService("acp-capability-probe");
    try {
      await vi.waitFor(() => expect(probed.length).toBeGreaterThan(0));
      expect(probed).not.toContain("amp-acp");
      expect(forkOf(host, "acp-amp")).toBe("none");
    } finally {
      run.controller.abort();
      await run.done;
    }
  });

  it("probes the configured replacement instead of the shipped command", async () => {
    const probed: string[] = [];
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "opencode",
        displayName: "Wrapper",
        command: "opencode-wrapper",
      }),
      hosts: [{ id: "host_1", status: "connected" }],
      probe: (command) => {
        probed.push(command);
        return { reachable: true, fork: command === "opencode-wrapper" };
      },
    });
    const run = host.harness.runService("acp-capability-probe");
    try {
      await vi.waitFor(() => expect(forkOf(host, "acp-opencode")).toBe("tip"));
      expect(probed).toContain("opencode-wrapper");
      expect(probed).not.toContain("opencode");
    } finally {
      run.controller.abort();
      await run.done;
    }
  });

  it("discovers new agents and changed commands without a host reconnect, and ignores a stale response", async () => {
    let resolveOld: (probe: AcpAgentProbe) => void = () => {
      throw new Error("probe not started");
    };
    const oldProbe = new Promise<AcpAgentProbe>((resolve) => {
      resolveOld = resolve;
    });
    const probed: string[] = [];
    const host = await loadPlugin({
      customAgents: "[]",
      hosts: [{ id: "host_1", status: "connected" }],
      probe: (command) => {
        probed.push(command);
        if (command === "old-amp") return oldProbe;
        return { reachable: true, fork: command === "new-amp" };
      },
    });
    vi.useFakeTimers();
    const run = host.harness.runService("acp-capability-probe");
    try {
      await vi.waitFor(() => expect(probed.length).toBeGreaterThan(0));
      await host.harness.setSettings({
        customAgents: customAgents({
          id: "amp",
          displayName: "Amp",
          command: "old-amp",
        }),
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(probed).toContain("old-amp"));
      await host.harness.setSettings({
        customAgents: customAgents({
          id: "amp",
          displayName: "Amp",
          command: "new-amp",
        }),
      });
      resolveOld({ reachable: true, fork: true });
      await Promise.resolve();
      expect(forkOf(host, "acp-amp")).toBe("none");
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(forkOf(host, "acp-amp")).toBe("tip"));
      expect(probed).toContain("new-amp");
      const before = probed.filter((command) => command === "new-amp").length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(probed.filter((command) => command === "new-amp")).toHaveLength(
        before,
      );
      await host.harness.setSettings({ customAgents: "[]" });
      await vi.waitFor(() =>
        expect(registeredIds(host)).not.toContain("acp-amp"),
      );
    } finally {
      resolveOld({ reachable: false, reason: "stopped" });
      run.controller.abort();
      await run.done;
      vi.useRealTimers();
    }
  });

  it.each(["args", "env"])(
    "refreshes discovery after changing %s on the same command",
    async (field) => {
      const agent = { id: "amp", displayName: "Amp", command: "amp-acp" };
      const host = await loadPlugin({
        customAgents: customAgents(agent),
        hosts: [{ id: "host_1", status: "connected" }],
        probe: (_command, _hostId, input) => ({
          reachable: true,
          fork:
            input.env.FORK_CAPABILITY === "1" ||
            input.args.includes("--fork-capability"),
        }),
      });
      vi.useFakeTimers();
      const run = host.harness.runService("acp-capability-probe");
      try {
        await vi.waitFor(() =>
          expect(
            host.harness.experimental_hostRpcCalls.some(
              (call) =>
                (call.input as { command: string }).command === "amp-acp",
            ),
          ).toBe(true),
        );
        expect(forkOf(host, "acp-amp")).toBe("none");
        const launch =
          field === "env"
            ? { env: { FORK_CAPABILITY: "1" } }
            : { args: ["--fork-capability"] };
        await host.harness.setSettings({
          customAgents: customAgents({ ...agent, ...launch }),
        });
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(() => expect(forkOf(host, "acp-amp")).toBe("tip"));
        await host.harness.setSettings({
          customAgents: customAgents({ ...agent, ...launch, fork: "none" }),
        });
        await vi.waitFor(() => expect(forkOf(host, "acp-amp")).toBe("none"));
      } finally {
        run.controller.abort();
        await run.done;
        vi.useRealTimers();
      }
    },
  );

  it("discovers a previously disabled custom agent after it is enabled", async () => {
    let enabled = false;
    const probed: string[] = [];
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "amp",
        displayName: "Amp",
        command: "amp-acp",
      }),
      hosts: [{ id: "host_1", status: "connected" }],
      probe: (command) => {
        probed.push(command);
        return { reachable: true, fork: true };
      },
    });
    host.harness.sdk.stub("providers.catalog", () =>
      Promise.resolve([{ id: "acp-amp", enabled }]),
    );
    vi.useFakeTimers();
    const run = host.harness.runService("acp-capability-probe");
    try {
      await vi.waitFor(() => expect(probed.length).toBeGreaterThan(0));
      expect(probed).not.toContain("amp-acp");
      expect(forkOf(host, "acp-amp")).toBe("none");
      enabled = true;
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(forkOf(host, "acp-amp")).toBe("tip"));
    } finally {
      run.controller.abort();
      await run.done;
      vi.useRealTimers();
    }
  });

  it.each([
    { supportFirst: false, checkpoint: false },
    { supportFirst: true, checkpoint: false },
    { supportFirst: false, checkpoint: true },
    { supportFirst: true, checkpoint: true },
  ])(
    "keeps the strongest automatic fork capability across connected hosts (%j)",
    async ({ supportFirst, checkpoint }) => {
      const hosts = [
        { id: "host_support", status: "connected" },
        { id: "host_unsupported", status: "connected" },
      ];
      if (!supportFirst) hosts.reverse();
      const host = await loadPlugin({
        customAgents: customAgents({
          id: "amp",
          displayName: "Amp",
          command: "amp-acp",
        }),
        hosts,
        probe: (_command, hostId) => ({
          reachable: true,
          fork: checkpoint || hostId === "host_support",
          checkpointFork: checkpoint && hostId === "host_support",
        }),
      });
      vi.useFakeTimers();
      const run = host.harness.runService("acp-capability-probe");
      try {
        await vi.waitFor(() =>
          expect(
            host.harness.experimental_hostRpcCalls.filter(
              (call) =>
                (call.input as { command: string }).command === "amp-acp",
            ),
          ).toHaveLength(2),
        );
        expect(forkOf(host, "acp-amp")).toBe(checkpoint ? "checkpoint" : "tip");
        for (const available of hosts) {
          if (available.id === "host_support")
            available.status = "disconnected";
        }
        await vi.advanceTimersByTimeAsync(5_000);
        expect(forkOf(host, "acp-amp")).toBe(checkpoint ? "tip" : "none");
      } finally {
        run.controller.abort();
        await run.done;
        vi.useRealTimers();
      }
    },
  );

  it("narrows a declared fork the agent does not advertise", async () => {
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "connected" }],
      probe: () => ({ reachable: true, fork: false }),
    });
    expect(forkOf(host, "acp-opencode")).toBe("tip");

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() => expect(forkOf(host, "acp-opencode")).toBe("none"));
    run.controller.abort();
    await run.done;
  });

  it("never widens a fork on an agent whose probe reports more", async () => {
    const probed: string[] = [];
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "connected" }],
      probe: (command) => {
        probed.push(command);
        return { reachable: true, fork: true };
      },
    });

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() => expect(probed.length).toBeGreaterThan(0));
    run.controller.abort();
    await run.done;

    expect(forkOf(host, "acp-opencode")).toBe("tip");
    expect(probed).not.toContain("cursor-agent");
    expect(forkOf(host, "acp-cursor")).toBe("none");
  });

  it("only spawns the agents a probe answer could change", async () => {
    const probed: string[] = [];
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "amp",
        displayName: "Amp",
        command: "amp",
      }),
      hosts: [{ id: "host_1", status: "connected" }],
      probe: (command) => {
        probed.push(command);
        return { reachable: false, reason: "not installed" };
      },
    });

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() => expect(probed.length).toBeGreaterThan(0));
    run.controller.abort();
    await run.done;

    expect(probed).not.toContain("cursor-agent");
    expect(probed).toContain("amp");
    expect(probed.length).toBeGreaterThan(0);
  });

  it("does not re-probe when a host worker exits", async () => {
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "connected" }],
      probe: () => ({ reachable: false, reason: "not installed" }),
    });

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() =>
      expect(host.harness.experimental_hostRpcCalls.length).toBeGreaterThan(0),
    );
    run.controller.abort();
    await run.done;
    const afterProbe = host.harness.experimental_hostRpcCalls.length;

    await host.harness.experimental_emitHostWorkerExit("host_1");

    expect(host.harness.experimental_hostRpcCalls).toHaveLength(afterProbe);
  });

  it("leaves no abort listener behind per poll", async () => {
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "connected" }],
      probe: () => ({ reachable: false, reason: "not installed" }),
    });

    const run = host.harness.runService("acp-capability-probe");
    const { signal } = run.controller;
    vi.useFakeTimers();
    try {
      for (let poll = 0; poll < 5; poll += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(host.harness.sdk.callsTo("hosts.list").length).toBeGreaterThan(2);
      expect(getEventListeners(signal, "abort").length).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }

    run.controller.abort();
    await run.done;
  });

  it("ignores a probe answer the probe schema rejects", async () => {
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "connected" }],
      probe: () => ({ reachable: true }),
    });

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() =>
      expect(host.harness.experimental_hostRpcCalls.length).toBeGreaterThan(0),
    );
    run.controller.abort();
    await run.done;

    expect(forkOf(host, "acp-opencode")).toBe("tip");
  });

  it("leaves the declaration alone when the agent is unreachable", async () => {
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "connected" }],
      probe: () => ({ reachable: false, reason: "not installed" }),
    });

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() =>
      expect(host.harness.experimental_hostRpcCalls.length).toBeGreaterThan(0),
    );
    run.controller.abort();
    await run.done;

    expect(forkOf(host, "acp-opencode")).toBe("tip");
  });

  it("probes nothing while every host is disconnected", async () => {
    const probed: string[] = [];
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "disconnected" }],
      probe: (command) => {
        probed.push(command);
        return { reachable: false, reason: "not installed" };
      },
    });

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() =>
      expect(host.harness.sdk.callsTo("hosts.list").length).toBeGreaterThan(0),
    );
    run.controller.abort();
    await run.done;

    expect(probed).toEqual([]);
  });
});

describe("known agent logos", () => {
  it("declares every agent logo in the manifest", () => {
    for (const agent of KNOWN_ACP_AGENTS) {
      if (agent.icon === undefined) continue;
      expect(agent.icon, agent.id).toMatch(
        new RegExp(`^${PLUGIN_ID}/[a-z0-9][a-z0-9-]*$`, "u"),
      );
      expect(DECLARED_ICON_NAMES, `${agent.id} icon ${agent.icon}`).toContain(
        agent.icon.slice(PLUGIN_ID.length + 1),
      );
    }
  });
});
