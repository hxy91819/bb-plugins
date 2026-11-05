import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  readCodexEnabledPluginSettingsFromToml,
  resolveCodexlHome,
  resolveCodexlNativeRoots,
} from "./native-roots.js";

const FIXTURE_HOME = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "native-roots",
  "home",
);

const FIXTURE_CODEXL_HOME = path.join(FIXTURE_HOME, ".codexl");

test("codexl home follows the wrapper's environment rules", () => {
  assert.equal(resolveCodexlHome("/home/u", {}), "/home/u/.codexl");
  assert.equal(
    resolveCodexlHome("/home/u", { CODEXL_HOME: "/opt/codexl" }),
    "/opt/codexl",
  );
  assert.equal(
    resolveCodexlHome("/home/u", {
      CODEXL_HOME: "/opt/codexl",
      ITFS_CODEX_LOCAL_HOME: "/opt/local",
    }),
    "/opt/local",
  );
  assert.equal(
    resolveCodexlHome("/home/u", { ITFS_CODEX_LOCAL_HOME: "relative/dir" }),
    "/home/u/.codexl",
  );
  assert.equal(
    resolveCodexlHome("/home/u", {
      ITFS_CODEX_LOCAL_HOME: "/mnt/shared/codex-home",
      ITFS_CODEX_SHARED_HOME: "/mnt/shared/codex-home",
    }),
    "/home/u/.codexl",
  );
});

test("codexl native roots cover personal and system skills by default", async () => {
  const answer = await resolveCodexlNativeRoots({
    providerId: "acp-codexl",
    homeDir: FIXTURE_HOME,
    env: {},
  });
  assert.deepEqual(
    answer.skills?.map((root) => [root.path, root.namePrefix ?? ""]),
    [
      [path.join(FIXTURE_CODEXL_HOME, "skills"), ""],
      [path.join(FIXTURE_CODEXL_HOME, "skills", ".system"), ""],
    ],
  );
  assert.deepEqual(answer.commands, []);
});

test("vendor plugin skills appear only when they are requested", async () => {
  const answer = await resolveCodexlNativeRoots({
    providerId: "acp-codexl",
    homeDir: FIXTURE_HOME,
    env: {},
    includeVendorPluginSkills: true,
  });
  assert.deepEqual(
    answer.skills?.map((root) => [root.path, root.namePrefix ?? ""]),
    [
      [path.join(FIXTURE_CODEXL_HOME, "skills"), ""],
      [path.join(FIXTURE_CODEXL_HOME, "skills", ".system"), ""],
      [
        path.join(
          FIXTURE_CODEXL_HOME,
          "plugins",
          "cache",
          "market",
          "enabled-plugin",
          "1.0.0",
          "skills",
        ),
        "enabled:",
      ],
    ],
  );
});

test("native roots stay empty for providers this plugin does not resolve", async () => {
  const answer = await resolveCodexlNativeRoots({
    providerId: "acp-kiro",
    homeDir: FIXTURE_HOME,
    env: {},
  });
  assert.deepEqual(answer, { skills: [], commands: [] });
});

test("codex plugin enable flags are read from config.toml", () => {
  const parsed = readCodexEnabledPluginSettingsFromToml(
    [
      '[plugins."quoted@market"]',
      "enabled = false",
      "",
      "[plugins.plain@market]",
      "enabled = true",
      "",
      "[other]",
      "enabled = false",
    ].join("\n"),
  );
  assert.deepEqual([...parsed], [
    ["quoted@market", false],
    ["plain@market", true],
  ]);
});
