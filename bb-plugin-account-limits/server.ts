import type { BbPluginApi, PluginProviderDeclaration, PluginProviderNativeRoots } from "@get-bb/plugin-sdk";
import { agyProvider } from "./agy-provider.js";
import { extraProviders } from "./extra-providers.js";
import { registerUsageSource } from "./usage-source.js";

const agents: Array<{ id: string; displayName: string; command: string; args: string[]; env: Record<string, string>; login: string; reasoningCli?: { flag: string; supportedLevels: string[] }; skillRoots?: PluginProviderNativeRoots; resolvesSkillRoots?: boolean }> = [
  {
    id: "acp-codexl", displayName: "CodexL", command: "/root/.nvm/versions/node/v24.15.0/bin/codex-acp", args: [], env: { CODEX_PATH: "/root/bin/codexl-bb", INITIAL_AGENT_MODE: "agent-full-access" }, login: "codexl-bb login",
    // wrapper 把 ~/.agents/skills 链进 CODEX_HOME/skills；插件缓存与 .system 由 host 端解析。
    skillRoots: { user: [".agents/skills"], project: [".codex/skills", { path: ".agents/skills", ancestors: true }] },
    resolvesSkillRoots: true,
  },
];

export const providers = agents.map((agent): PluginProviderDeclaration => ({
  id: agent.id,
  displayName: agent.displayName,
  family: "acp",
  icon: "Terminal",
  strings: {
    installUrl: "https://github.com/agentclientprotocol/codex-acp",
    signInHint: `Run \`${agent.login}\` on the machine, then reload usage.`,
    expiredHint: `Session expired. Run \`${agent.login}\`, then reload usage.`,
  },
  experimental_bridgeOptions: {
    acpDialect: "generic",
    acpLaunchSpec: {
      displayName: agent.displayName,
      command: agent.command,
      args: agent.args,
      env: agent.env,
      ...(agent.reasoningCli === undefined ? {} : { reasoningCli: agent.reasoningCli }),
    },
  },
  ...(agent.skillRoots === undefined ? {} : { experimental_nativeSkillRoots: agent.skillRoots }),
  ...(agent.resolvesSkillRoots === true ? { experimental_resolvesNativeRoots: true } : {}),
  maintenance: { health: true, usage: false, installation: false },
  models: { scope: "host" },
  capabilities: {
    supportsServiceTier: true,
    supportsNativeUserQuestion: false,
    supportsManualCompaction: false,
    fork: "none",
    supportsThreadArchive: false,
    supportsThreadRename: false,
    permissionModes: ["accept-edits", "full"],
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  serviceTiers: [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }],
  composerActions: [],
}));

export default function accountLimitsPlugin(bb: BbPluginApi) {
  for (const provider of providers) bb.providers.register(provider);
  bb.providers.register(agyProvider);
  for (const provider of extraProviders) bb.providers.register(provider);
  registerUsageSource(bb, new Set([...providers, agyProvider].filter(p => p.maintenance?.usage).map(p => p.id)));
  bb.cli.register({
    name: "account-limits",
    summary: "Query active local ACP usage sources through BB's usage limits service",
    commands: [{ name: "show", summary: "Read account limits", usage: "bb account-limits [--host <id>]" }],
    async run(argv) {
      if (argv.includes("--help")) return { exitCode: 0, stdout: "Usage: bb account-limits [--host <id>]\n" };
      if (argv.length !== 0 && !(argv.length === 2 && argv[0] === "--host")) {
        return { exitCode: 2, stderr: "Usage: bb account-limits [--host <id>]\n" };
      }
      const usage = await bb.sdk.system.usageLimits(argv.length ? { hostId: argv[1] } : {});
      return { exitCode: 0, stdout: JSON.stringify(Object.fromEntries([...providers, agyProvider].filter(p => p.maintenance?.usage).map(p => [p.id, usage[p.id] ?? null])), null, 2) + "\n" };
    },
  });
}
