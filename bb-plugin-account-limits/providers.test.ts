import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PluginProviderDeclaration,
  PluginProviderNativeRoots,
} from "@get-bb/plugin-sdk";
import { agyProvider } from "./agy-provider.js";
import { extraProviders } from "./extra-providers.js";
import { providers } from "./server.js";

const declared = new Map<string, PluginProviderDeclaration>(
  [...providers, agyProvider, ...extraProviders].map((provider) => [
    provider.id,
    provider,
  ]),
);

function rootPaths(
  roots: PluginProviderNativeRoots | undefined,
  side: "user" | "project",
): string[] {
  return (roots?.[side] ?? []).map((root) =>
    typeof root === "string" ? root : root.path,
  );
}

test("ACP providers declare the native skill roots bb indexes", () => {
  // bb 只索引声明里的技能根；漏掉一处，该 provider 的 `/` 菜单就只剩 bb 自带技能。
  assert.deepEqual(
    rootPaths(
      declared.get("acp-codexl")?.experimental_nativeSkillRoots,
      "user",
    ),
    [".agents/skills"],
  );
  assert.equal(
    declared.get("acp-codexl")?.experimental_resolvesNativeRoots,
    true,
  );
  assert.equal(declared.has("acp-kiro"), false);
  assert.deepEqual(
    rootPaths(declared.get("acp-agy")?.experimental_nativeSkillRoots, "user"),
    [".gemini/config/skills"],
  );
  // Copilot 在本机没有可确认的技能目录，保持不声明。
  assert.equal(
    declared.get("acp-copilot")?.experimental_nativeSkillRoots,
    undefined,
  );
});
