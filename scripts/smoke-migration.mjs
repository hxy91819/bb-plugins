import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtime = resolve(process.env.BB_PLUGINS_RUNTIME_DIR ?? "");
const supply = JSON.parse(
  await readFile(join(root, "bb-runtime.json"), "utf8"),
);
const release = JSON.parse(
  await readFile(join(runtime, "release.json"), "utf8"),
);
assert.equal(release.source, supply.source);
const directory = await mkdtemp(join(tmpdir(), "bb-collection-smoke-"));
const data = join(directory, "data");
const processes = [];
const env = { ...process.env };
for (const key of [
  "BB_CLI",
  "BB_CLI_REEXEC",
  "BB_THREAD_ID",
  "BB_PROJECT_ID",
  "BB_ENVIRONMENT_ID",
])
  delete env[key];
env.PATH = `${join(runtime, "bin")}:${env.PATH ?? ""}`;
env.BB_DATA_DIR = data;
env.XDG_CACHE_HOME = join(directory, "cache");
const node = join(runtime, "bin/node");
const entry = (name) => join(runtime, "node_modules/bb-app/dist", name);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function port() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const value = listener.address().port;
  await new Promise((done) => listener.close(done));
  return value;
}
async function run(command, args, cwd = root) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    error = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (error += chunk));
  const [code] = await once(child, "exit");
  if (code !== 0)
    throw new Error(
      `${command} ${args.slice(0, 3).join(" ")}: ${output}\n${error}`,
    );
  return output;
}
async function cli(args) {
  const result = JSON.parse(
    await run(node, [entry("bb.js"), ...args, "--json"]),
  );
  assert.notEqual(result.ok, false, JSON.stringify(result));
  return result;
}
async function request(path, input) {
  const response = await fetch(
    `${env.BB_SERVER_URL}${path}`,
    input === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
  );
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}
async function until(check) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error("Isolated instance did not become ready");
}
function launch(name, args, additions = {}) {
  const child = spawn(node, [entry(name), ...args], {
    cwd: root,
    env: { ...env, ...additions },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(join(directory, `${name}.log`));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  processes.push(child);
  return child;
}
try {
  await mkdir(data);
  const serverPort = await port();
  env.BB_SERVER_URL = `http://127.0.0.1:${serverPort}`;
  const server = launch("bb-server.js", [
    "--data-dir",
    data,
    "--server-bind-host",
    "127.0.0.1",
    "--server-port",
    String(serverPort),
  ]);
  await until(async () => {
    if (server.exitCode !== null) throw new Error("Isolated server exited");
    return fetch(`${env.BB_SERVER_URL}/health`)
      .then((response) => response.ok)
      .catch(() => false);
  });
  const enrollment = await request("/internal/hosts/enroll-key", {});
  launch("bb-host-daemon.js", [], {
    BB_HOST_ID: enrollment.hostId,
    BB_HOST_ENROLL_KEY: enrollment.enrollKey,
    BB_HOST_DAEMON_PORT: String(await port()),
  });
  await until(async () =>
    (await request("/api/v1/hosts")).some(
      (host) => host.id === enrollment.hostId && host.status === "connected",
    ),
  );
  for (const name of ["team", "acp-profile-icons"]) {
    const old = join(directory, name);
    await cp(join(root, "plugins", name), old, {
      recursive: true,
      filter: (path) => !path.split("/").includes("node_modules"),
    });
    await symlink(
      join(root, "plugins", name, "node_modules"),
      join(old, "node_modules"),
    );
    await cli(["plugin", "install", `path:${old}`, "--yes"]);
  }
  await cli(["plugin", "disable", "team"]);
  await cli([
    "plugin",
    "install",
    "https://github.com/hxy91819/bb-plugin-bookmarks@9f7b9d1ed61119416ee273f30aef6f0eed141306",
    "--yes",
  ]);
  await cli(["plugin", "config", "bookmarks", "set", "language", "zh-CN"]);
  const projectPath = join(directory, "project");
  await mkdir(projectPath);
  const project = await request("/api/v1/projects", {
    name: "Collection migration",
    source: {
      type: "local_path",
      hostId: enrollment.hostId,
      path: projectPath,
    },
  });
  const created = await request("/api/v1/threads", {
    projectId: project.id,
    origin: "app",
    providerId: "codex",
    model: "gpt-5.4",
    environment: { type: "project-default" },
    input: [{ type: "text", text: "Scheduled migration fixture" }],
    sendAt: Date.now() + 3_600_000,
  });
  const saved = await request("/api/v1/plugins/bookmarks/rpc/add", {
    threadId: created.id,
    messageSeq: 1,
    text: "Migration must retain this saved text",
  });
  assert.equal(saved.ok, true);
  const sourceBefore = await cli(["plugin", "source", "bookmarks"]);
  const manifestPath = join(root, "plugins/bookmarks/package.json");
  await rename(manifestPath, `${manifestPath}.smoke-disabled`);
  try {
    await assert.rejects(
      run(node, [join(root, "scripts/migrate-installed.mjs"), "bookmarks"]),
    );
  } finally {
    await rename(`${manifestPath}.smoke-disabled`, manifestPath);
  }
  assert.equal(
    (await cli(["plugin", "source", "bookmarks"])).requested,
    sourceBefore.requested,
  );
  assert.equal(
    (await cli(["bookmarks", "list"])).bookmarks[0].id,
    saved.result.id,
  );
  assert.equal(
    (await cli(["plugin", "config", "bookmarks"])).values.language,
    "zh-CN",
  );
  await run(node, [
    join(root, "scripts/migrate-installed.mjs"),
    "team",
    "bookmarks",
    "acp-profile-icons",
  ]);
  const installed = (await cli(["plugin", "list"])).plugins;
  assert.equal(installed.find((plugin) => plugin.id === "team").enabled, false);
  assert.equal(
    installed.find((plugin) => plugin.id === "acp-profile-icons").status,
    "running",
  );
  const bookmarks = await cli(["bookmarks", "list"]);
  assert.equal(bookmarks.total, 1);
  assert.equal(bookmarks.bookmarks[0].id, saved.result.id);
  assert.equal(
    bookmarks.bookmarks[0].text,
    "Migration must retain this saved text",
  );
  const bookmarkSettings = await cli(["plugin", "config", "bookmarks"]);
  assert.deepEqual(bookmarkSettings.schema, {});
  assert.deepEqual(bookmarkSettings.values, {});
  await cli(["thread-list", "prefs", "set", "dateGrouping", "false"]);
  await run(node, [join(root, "scripts/migrate-native.mjs"), "thread-list"]);
  assert.equal(
    (await cli(["thread-list-extras", "prefs", "get", "dateGrouping"])).value,
    false,
  );
  assert.equal(
    (await cli(["settings", "ui", "get", "sidebar.threadListProvider"])).value,
    "thread-list-extras/thread-list",
  );
  await run(node, [join(root, "scripts/migrate-native.mjs"), "acp"]);
  assert.equal(
    (await cli(["plugin", "list"])).plugins.find(
      (plugin) => plugin.id === "acp-extensions",
    ).status,
    "running",
  );
  console.log(
    "PASS: five standalone packages install; path and managed Git migration preserve plugin IDs, enabled state, configuration and saved bookmark data; independent sidebar CLI and ACP registration run.",
  );
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
  for (const child of processes.reverse()) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await Promise.race([once(child, "exit"), delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await once(child, "exit");
    }
  }
  if (process.exitCode) console.error(`Diagnostic evidence: ${directory}`);
  else await rm(directory, { recursive: true, force: true });
}
