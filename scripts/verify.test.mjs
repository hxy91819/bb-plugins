import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const collection = JSON.parse(
  await readFile(new URL(".bb/plugins.json", root), "utf8"),
);
const supply = JSON.parse(
  await readFile(new URL("bb-runtime.json", root), "utf8"),
);

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "bb-collection-runner-"));
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, ".bb"));
    await mkdir(join(directory, "runtime/bin"), { recursive: true });
    await cp(
      new URL("scripts/verify.mjs", root),
      join(directory, "scripts/verify.mjs"),
    );
    await writeFile(
      join(directory, ".bb/plugins.json"),
      JSON.stringify(collection),
    );
    await writeFile(join(directory, "bb-runtime.json"), JSON.stringify(supply));
    await writeFile(
      join(directory, "runtime/release.json"),
      JSON.stringify(supply),
    );
    for (const plugin of collection.plugins) {
      await mkdir(join(directory, plugin.source), { recursive: true });
      await cp(
        new URL(`${plugin.source}/package.json`, root),
        join(directory, plugin.source, "package.json"),
      );
    }
    const logger = `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.RUNNER_TEST_LOG, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),cli:process.env.BB_CLI??null,reexec:process.env.BB_CLI_REEXEC??null})+'\\n');\nprocess.exit(process.env.RUNNER_TEST_FAIL && process.cwd().endsWith(process.env.RUNNER_TEST_FAIL) ? 7 : 0);\n`;
    for (const binary of ["npm", "bb"]) {
      await writeFile(join(directory, "runtime/bin", binary), logger);
      await chmod(join(directory, "runtime/bin", binary), 0o755);
    }
    const log = join(directory, "calls.jsonl");
    const invoke = async (task, extra = {}) => {
      await writeFile(log, "");
      const result = spawnSync(
        process.execPath,
        [join(directory, "scripts/verify.mjs"), task],
        {
          env: {
            ...process.env,
            BB_PLUGINS_RUNTIME_DIR: join(directory, "runtime"),
            RUNNER_TEST_LOG: log,
            BB_CLI: "/must-not-use-parent-cli",
            BB_CLI_REEXEC: "1",
            ...extra,
          },
          encoding: "utf8",
        },
      );
      const rows = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      return { result, rows };
    };
    await run({ directory, invoke });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("standard collection runner cold CI, types, tests and builds include every member on the pinned runtime", async () => {
  const downloadManifest = JSON.parse(
    await readFile(new URL("plugins/file-download/package.json", root), "utf8"),
  );
  assert.ok(
    downloadManifest.devDependencies["@get-bb/plugin-sdk"].startsWith(
      `${supply.baseUrl}/`,
    ),
    "collection runtime must match the download plugin SDK release",
  );
  assert.ok(
    collection.plugins.some((plugin) => plugin.name === "file-download"),
  );
  for (const name of [
    "team",
    "bookmarks",
    "thread-list",
    "acp",
    "acp-compat",
    "acp-profile-icons",
    "machine-gateway",
    "composer-tools",
    "thread-search",
  ])
    assert.ok(
      collection.plugins.some((plugin) => plugin.name === name),
      `${name} must remain in the collection`,
    );
  await fixture(async ({ directory, invoke }) => {
    for (const task of ["ci", "typecheck", "test", "build"]) {
      const { result, rows } = await invoke(task);
      assert.equal(result.status, 0, result.stderr);
      const expected = [];
      for (const plugin of collection.plugins) {
        const manifest = JSON.parse(
          await readFile(
            new URL(`${plugin.source}/package.json`, root),
            "utf8",
          ),
        );
        if (task === "test" && !manifest.scripts?.test) continue;
        expected.push({
          cwd: join(directory, plugin.source),
          args:
            task === "build"
              ? ["plugin", "build", join(directory, plugin.source)]
              : task === "ci"
                ? ["ci", "--no-audit", "--no-fund", "--legacy-peer-deps"]
                : ["run", task],
          cli: null,
          reexec: null,
        });
      }
      assert.deepEqual(rows, expected);
    }
  });
});

test("a member failure fails the collection without dropping subsequent members", async () => {
  await fixture(async ({ invoke }) => {
    const { result, rows } = await invoke("typecheck", {
      RUNNER_TEST_FAIL: "/plugins/team",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /team: typecheck exited 7/);
    assert.equal(rows.length, collection.plugins.length);
    assert.ok(rows.at(-1).cwd.endsWith("/plugins/file-download"));
  });
});

test("a mismatched runtime is rejected before any member command", async () => {
  await fixture(async ({ directory, invoke }) => {
    await writeFile(
      join(directory, "runtime/release.json"),
      JSON.stringify({ ...supply, source: "old-runtime" }),
    );
    const { result, rows } = await invoke("build");
    assert.equal(result.status, 1);
    assert.ok(
      result.stderr.includes(`Use the documented BB ${supply.tag} runtime`),
    );
    assert.deepEqual(rows, []);
  });
});
