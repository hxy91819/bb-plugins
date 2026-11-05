import type { PluginProviderDeclaration, PluginProviderNativeRoots } from "@get-bb/plugin-sdk";

const agents: Array<{ id: string; displayName: string; icon: string; skillRoots?: PluginProviderNativeRoots; launch: {
  displayName: string; command: string; args: string[]; env: Record<string, string>;
  permissionCli: Record<string, string[]>;
} }> = [
  {
    id: "acp-copilot", displayName: "GitHub Copilot", icon: "Bot",
    launch: {
      displayName: "GitHub Copilot", command: "/root/.nvm/versions/node/v24.15.0/bin/copilot",
      args: ["--acp"], env: {}, permissionCli: { full: ["--yolo"] },
    },
  },
];

export const extraProviders = agents.map(({ launch, skillRoots, ...agent }): PluginProviderDeclaration => ({
  ...agent, family: "acp",
  ...(skillRoots === undefined ? {} : { experimental_nativeSkillRoots: skillRoots }),
  experimental_bridgeOptions: { acpLaunchSpec: launch },
  models: { scope: "host" },
  maintenance: { health: true, usage: false, installation: false },
  capabilities: {
    supportsServiceTier: true, supportsNativeUserQuestion: false,
    supportsManualCompaction: false, supportsThreadArchive: false,
    supportsThreadRename: false, fork: "none",
    permissionModes: ["accept-edits", "full"],
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  serviceTiers: [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }],
  composerActions: [],
}));
