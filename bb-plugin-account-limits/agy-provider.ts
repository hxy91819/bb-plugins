import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";

export const agyProvider: PluginProviderDeclaration = {
  id: "acp-agy",
  displayName: "Antigravity (AGY)",
  family: "acp",
  icon: "Zap",
  strings: {
    installUrl: "https://github.com/shubzkothekar/antigravity-acp",
    signInHint: "Run `agy` on the machine to sign in.",
    expiredHint: "Run `agy` on the machine to renew the login.",
  },
  // agy 的全局技能目录（`~/.gemini/config/skills`，本机链到 ~/.agents/skills）。
  experimental_nativeSkillRoots: { user: [".gemini/config/skills"] },
  experimental_bridgeOptions: {
    acpDialect: "generic",
    acpLaunchSpec: {
      displayName: "Antigravity (AGY)",
      command: "/root/.bun/bin/bun",
      args: ["/data/code/bb-local-agents/agy-entry.mjs"],
      // agy -p 默认 5 分钟会在任务未结束时退出，ACP 必须显式延长等待。
      env: { AGY_BIN: "/root/.local/bin/agy", AGY_SKIP_DOWNLOAD: "1", AGY_EXTRA_ARGS: "--print-timeout 2h" },
    },
  },
  maintenance: { health: true, usage: true, installation: false },
  models: { scope: "host" },
  capabilities: {
    // antigravity-acp 1.1.0 无条件跳过 agy 审批，不能向用户声明支持受限模式。
    permissionModes: ["full"],
    supportsServiceTier: false,
    supportsNativeUserQuestion: false,
    supportsManualCompaction: false,
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "none",
    reasoningLevels: ["medium"],
  },
  composerActions: [],
};
