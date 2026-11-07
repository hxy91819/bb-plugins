import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function dshAutoReview(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    command: { type: "string", label: "DSH executable", default: "dsh" },
    profile: { type: "string", label: "DSH ACP profile", default: "acp" },
  });
  let registration: { dispose(): void } | undefined;
  const register = (config: { command: string; profile: string }) => {
    registration?.dispose();
    registration = bb.providers.register({
      id: "dsh-auto-review",
      displayName: "DSH Auto Review",
      family: "acp",
      icon: "ShieldCheck",
      strings: {
        signInHint:
          "Configure model credentials in the DSH ACP profile on this machine.",
        expiredHint: "Refresh the DSH model credentials on this machine.",
        installUrl: "https://github.com/deepseek-ai/deepseek-harness",
      },
      experimental_nativeSkillRoots: {
        user: [{ path: ".agents/skills", recursive: true }],
        project: [{ path: ".agents/skills", recursive: true, ancestors: true }],
      },
      models: { scope: "host" },
      maintenance: { health: true, usage: false, installation: false },
      capabilities: {
        supportsServiceTier: true,
        supportsManualCompaction: false,
        supportsNativeUserQuestion: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        fork: "none",
        permissionModes: ["auto"],
        reasoningLevels: ["none", "low", "high", "max"],
      },
      serviceTiers: [
        { id: "default", label: "Default" },
        { id: "fast", label: "Fast" },
      ],
      composerActions: [],
      experimental_bridgeOptions: {
        acpLaunchSpec: {
          displayName: "DSH Auto Review",
          command: config.command,
          args: ["--profile", config.profile],
          env: {},
          nativeReasoning: {
            configId: "reasoning_effort",
            supportedLevels: ["none", "low", "high", "max"],
            levelValues: { none: "off" },
            defaultLevel: "high",
          },
        },
      },
    });
  };
  register(await settings.get());
  settings.onChange(register);
}
