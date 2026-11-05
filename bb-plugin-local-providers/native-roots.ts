import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  experimental_filterResolvedNativeRoots,
  experimental_resolveVendorPluginRoots,
  type ExperimentalNativeRootsResolveAnswer,
  type ExperimentalVendorPlugin,
} from "@get-bb/plugin-sdk/host";
import { z } from "zod";

const CODEXL_HOME_DIR_NAME = ".codexl";
const CODEX_PLUGIN_DIR_NAME = ".codex-plugin";
const CODEX_PLUGIN_MANIFEST_FILE_NAME = "plugin.json";
const CODEX_CONFIG_FILE_NAME = "config.toml";

/**
 * codex 插件技能（`openai-templates:*` 等）默认不进 `/` 菜单：它们来自 codex
 * 的 vendor 插件缓存，和个人技能混在一起噪音太大。改成 true 即恢复与 codex 一致。
 */
export const INCLUDE_CODEX_PLUGIN_SKILLS = false;

export type ResolvedSkillRoot = NonNullable<
  ExperimentalNativeRootsResolveAnswer["skills"]
>[number];

/**
 * CodexL 的运行态目录由 `/root/bin/codexl-bb` 决定：`ITFS_CODEX_LOCAL_HOME`
 * 优先，其次 `CODEXL_HOME`，默认 `~/.codexl`。wrapper 拒绝把共享 FUSE 目录
 * 当作本机运行态，这里保持同一规则，否则会索引到另一份技能。
 */
export function resolveCodexlHome(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const shared = env["ITFS_CODEX_SHARED_HOME"] ?? env["ITFS_CODEX_HOME"];
  const requested = (env["ITFS_CODEX_LOCAL_HOME"] ?? env["CODEXL_HOME"])?.trim();
  if (
    requested !== undefined &&
    requested.length > 0 &&
    path.isAbsolute(requested) &&
    requested !== shared
  ) {
    return requested;
  }
  return path.join(homeDir, CODEXL_HOME_DIR_NAME);
}

export interface ResolveCodexlNativeRootsArgs {
  providerId: string;
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  includeVendorPluginSkills?: boolean;
}

export async function resolveCodexlNativeRoots(
  args: ResolveCodexlNativeRootsArgs,
): Promise<ExperimentalNativeRootsResolveAnswer> {
  if (args.providerId !== "acp-codexl") {
    return { skills: [], commands: [] };
  }
  const codexlHome = resolveCodexlHome(args.homeDir, args.env);
  const skillsRootPath = path.join(codexlHome, "skills");
  const includeVendorPluginSkills =
    args.includeVendorPluginSkills ?? INCLUDE_CODEX_PLUGIN_SKILLS;
  const skills: ResolvedSkillRoot[] = [
    { path: skillsRootPath, origin: "user", shape: "skills" },
    {
      path: path.join(skillsRootPath, ".system"),
      origin: "user",
      shape: "skills",
    },
    ...(includeVendorPluginSkills
      ? await resolveCodexPluginSkillRoots(codexlHome)
      : []),
  ];
  return experimental_filterResolvedNativeRoots(
    { skills },
    { warn: console.warn },
  ).answer;
}

const pluginPathListSchema = z.union([z.string(), z.array(z.string())]);

const codexPluginManifestSchema = z
  .object({
    name: z.string().min(1).optional(),
    skills: pluginPathListSchema.optional(),
  })
  .passthrough();

export function readCodexEnabledPluginSettingsFromToml(
  content: string,
): ReadonlyMap<string, boolean> {
  const enabledPlugins = new Map<string, boolean>();
  let currentPluginId: string | null = null;

  for (const line of content.split(/\r?\n/u)) {
    const sectionMatch = line.match(
      /^\s*\[plugins\.(?:"((?:\\.|[^"\\])*)"|([^\]\s]+))\]\s*(?:#.*)?$/u,
    );
    if (sectionMatch) {
      currentPluginId = sectionMatch[1] ?? sectionMatch[2] ?? null;
      continue;
    }
    if (/^\s*\[/u.test(line)) {
      currentPluginId = null;
      continue;
    }
    if (currentPluginId === null) {
      continue;
    }
    const enabledMatch = line.match(
      /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/u,
    );
    if (enabledMatch) {
      enabledPlugins.set(currentPluginId, enabledMatch[1] === "true");
    }
  }

  return enabledPlugins;
}

async function readEnabledCodexPlugins(
  codexlHome: string,
): Promise<ReadonlyMap<string, boolean>> {
  try {
    return readCodexEnabledPluginSettingsFromToml(
      await fs.readFile(path.join(codexlHome, CODEX_CONFIG_FILE_NAME), "utf8"),
    );
  } catch {
    return new Map();
  }
}

async function readDirectoryEntries(directoryPath: string): Promise<Dirent[]> {
  try {
    return (await fs.readdir(directoryPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

async function readCodexPluginManifest(
  pluginRootPath: string,
): Promise<z.infer<typeof codexPluginManifestSchema> | null> {
  let content: string;
  try {
    content = await fs.readFile(
      path.join(
        pluginRootPath,
        CODEX_PLUGIN_DIR_NAME,
        CODEX_PLUGIN_MANIFEST_FILE_NAME,
      ),
      "utf8",
    );
  } catch {
    return null;
  }
  try {
    const parsed = codexPluginManifestSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function resolveLatestPluginCacheRoot(
  pluginCacheRootPath: string,
): Promise<string | null> {
  const candidates: Array<{ rootPath: string; modifiedAtMs: number }> = [];
  for (const entry of await readDirectoryEntries(pluginCacheRootPath)) {
    const rootPath = path.join(pluginCacheRootPath, entry.name);
    if ((await readCodexPluginManifest(rootPath)) === null) {
      continue;
    }
    const stat = await fs.stat(rootPath).catch(() => null);
    if (stat !== null) {
      candidates.push({ rootPath, modifiedAtMs: stat.mtimeMs });
    }
  }
  return (
    candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)[0]
      ?.rootPath ?? null
  );
}

async function resolveEnabledCodexPlugins(
  codexlHome: string,
): Promise<ExperimentalVendorPlugin[]> {
  const enabledPlugins = await readEnabledCodexPlugins(codexlHome);
  const cacheRootPath = path.join(codexlHome, "plugins", "cache");
  const plugins: ExperimentalVendorPlugin[] = [];

  for (const marketplaceEntry of await readDirectoryEntries(cacheRootPath)) {
    const marketplacePath = path.join(cacheRootPath, marketplaceEntry.name);
    for (const pluginEntry of await readDirectoryEntries(marketplacePath)) {
      if (
        enabledPlugins.get(`${pluginEntry.name}@${marketplaceEntry.name}`) ===
        false
      ) {
        continue;
      }
      const rootPath = await resolveLatestPluginCacheRoot(
        path.join(marketplacePath, pluginEntry.name),
      );
      if (rootPath === null) {
        continue;
      }
      const manifest = await readCodexPluginManifest(rootPath);
      if (manifest === null) {
        continue;
      }
      plugins.push({
        rootPath,
        name: manifest.name ?? pluginEntry.name,
        origin: "user",
        skills: manifest.skills,
      });
    }
  }
  return plugins;
}

async function resolveCodexPluginSkillRoots(
  codexlHome: string,
): Promise<ResolvedSkillRoot[]> {
  const roots = await experimental_resolveVendorPluginRoots({
    plugins: await resolveEnabledCodexPlugins(codexlHome),
    layout: "claude",
  });
  return roots.skills;
}
