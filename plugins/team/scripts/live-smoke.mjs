import { fileURLToPath } from "node:url";
import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  writeFile,
  cp,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { chromium, webkit, expect as playwrightExpect } from "@playwright/test";
import { createRequire } from "node:module";
import { node, cli, server, env, provenance, runtime } from "./runtime.mjs";
const require = createRequire(join(runtime, "package.json"));
const { BBSdk } = require("bb-app");
const bbCli = cli;
const expect = playwrightExpect.configure({ timeout: 15000 });

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = process.env.BB_TEAM_EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
const data = await mkdtemp(join(tmpdir(), "bb-team-live-"));
await writeFile(join(data, "bb-team-owner"), String(process.pid));
const upgradeFrom = process.env.BB_TEAM_UPGRADE_FROM;
if (upgradeFrom && !/^[a-f0-9]{40}$/.test(upgradeFrom))
  throw Error("BB_TEAM_UPGRADE_FROM must be an exact local commit SHA");
const installDirectory = process.env.BB_TEAM_INSTALL_DIR;
if (installDirectory && upgradeFrom)
  throw Error("Archive installation and legacy upgrade are separate journeys");
const livePlugin = installDirectory
  ? resolve(installDirectory)
  : join(data, "plugin");
if (!installDirectory) await mkdir(livePlugin);
async function copyCurrentPlugin() {
  for (const entry of [
    "package.json",
    "server.ts",
    "app.tsx",
    "src",
    "components",
    "lib",
    "assets",
    "skills",
  ])
    await cp(join(root, entry), join(livePlugin, entry), { recursive: true });
}
if (upgradeFrom) {
  const archive = join(data, "previous-source.tar");
  execFileSync(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${archive}`,
      upgradeFrom,
      "package.json",
      "server.ts",
      "app.tsx",
      "src",
      "components",
      "lib",
      "assets",
      "skills",
    ],
    { cwd: root },
  );
  execFileSync("tar", ["-xf", archive, "-C", livePlugin]);
} else if (!installDirectory) await copyCurrentPlugin();
if (!installDirectory)
  await symlink(
    join(root, "node_modules"),
    join(livePlugin, "node_modules"),
    "dir",
  );
const portServer = createServer();
portServer.listen(0, "127.0.0.1");
await once(portServer, "listening");
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const url = `http://127.0.0.1:${port}`;

const serverEnv = { ...env, BB_DATA_DIR: data, BB_SERVER_URL: url };
delete serverEnv.BB_THREAD_ID;
delete serverEnv.BB_PROJECT_ID;
delete serverEnv.BB_ENVIRONMENT_ID;

const child = spawn(
  node,
  [
    server,
    "--data-dir",
    data,
    "--server-bind-host",
    "127.0.0.1",
    "--server-port",
    String(port),
  ],
  { env: serverEnv, stdio: "ignore", detached: true },
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopGroup(child) {
  if (!child?.pid) return;
  const signal = (value) => {
    try {
      process.kill(-child.pid, value);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  if (!signal("SIGTERM")) return;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!signal(0)) return;
    if (attempt === 50) signal("SIGKILL");
    await delay(100);
  }
  throw Error(`Owned process group ${child.pid} did not exit`);
}

async function runCli(args) {
  const child = spawn(node, [bbCli, ...args], { env: serverEnv, cwd: root });
  let out = "",
    err = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (err += b));
  const [code] = await once(child, "exit");
  if (code !== 0) throw Error(`${args.join(" ")}: ${out}\n${err}`);
  return out;
}

async function rpc(method, input = null) {
  const response = await fetch(`${url}/api/v1/plugins/team/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!result.ok) {
    console.error(`RPC ${method} failed:`, JSON.stringify(result));
    throw Error(JSON.stringify(result));
  }
  return result.result;
}

async function enterApp(page) {
  diagnosticPage = page;
  await page.goto(url);
  const skip = page.getByRole("button", { name: "Skip setup", exact: true });
  await skip
    .or(page.getByRole("dialog", { name: "选择团队身份", exact: true }))
    .or(page.getByRole("button", { name: /^当前身份：/ }))
    .filter({ visible: true })
    .first()
    .waitFor();
  if (
    (await skip.isVisible()) &&
    !(await page
      .getByRole("dialog", { name: "选择团队身份", exact: true })
      .isVisible())
  )
    await skip.click();
}
async function openPicker(page) {
  await page
    .getByRole("button", { name: /^(当前身份：.*，切换身份|选择身份)$/ })
    .click();
  await expect(
    page.getByRole("dialog", { name: "选择团队身份", exact: true }),
  ).toBeVisible();
}
let browser;
let diagnosticPage;
let daemon;
const clippedAvatars = [];

try {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) break;
    } catch {}
    if (attempt > 120)
      throw Error(
        `server startup timed out: ${await readFile(join(data, "logs/server-stdio.log"), "utf8")}`,
      );
    await delay(250);
  }
  console.log(`Isolated BB fork ${provenance.source} server ready`);
  console.log(
    await runCli(["plugin", "install", livePlugin, "--yes", "--json"]),
  );
  if (process.env.BB_TEAM_TEST_PROVIDER_DIR) {
    console.log(
      await runCli([
        "plugin",
        "install",
        process.env.BB_TEAM_TEST_PROVIDER_DIR,
        "--yes",
        "--json",
      ]),
    );
    const enrollment = await fetch(`${url}/internal/hosts/enroll-key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!enrollment.ok) throw Error("Isolated host enrollment failed");
    const { hostId, enrollKey } = await enrollment.json();
    const daemonPortServer = createServer();
    daemonPortServer.listen(0, "127.0.0.1");
    await once(daemonPortServer, "listening");
    const daemonPort = daemonPortServer.address().port;
    await new Promise((resolve) => daemonPortServer.close(resolve));
    serverEnv.BB_HOST_DAEMON_PORT = String(daemonPort);
    daemon = spawn(
      node,
      [join(runtime, "node_modules/bb-app/dist/bb-host-daemon.js")],
      {
        env: {
          ...serverEnv,
          BB_HOST_ID: hostId,
          BB_HOST_ENROLL_KEY: enrollKey,
        },
        detached: true,
        stdio: "ignore",
      },
    );
    await expect
      .poll(
        async () => {
          const hosts = await new BBSdk({ baseUrl: url }).hosts.list();
          return hosts.find((host) => host.id === hostId)?.status;
        },
        { timeout: 60000 },
      )
      .toBe("connected");
    console.log("PASS: isolated matching daemon connected");
  }

  if (upgradeFrom) {
    if (!process.env.BB_TEAM_TEST_PROVIDER_DIR)
      throw Error(
        "Upgrade evidence requires the normal-protocol provider fixture",
      );
    const legacy = await rpc("initialize", {
      displayName: "Legacy administrator",
      avatarId: "fox",
    });
    expect(legacy.status).toBe("initialized");
    const id = legacy.member.memberId;
    const ordinary = await rpc("members_create", {
      actorMemberId: id,
      displayName: "Legacy member",
      avatarId: "owl",
    });
    const sdk = new BBSdk({ baseUrl: url });
    const host = (await sdk.hosts.list()).find(
      (host) => host.status === "connected",
    );
    const path = join(data, "upgrade-project");
    await mkdir(path);
    const project = await sdk.projects.create({
      name: "Upgrade evidence",
      source: { type: "local_path", hostId: host.id, path },
    });
    const thread = await sdk.threads.spawn({
      projectId: project.id,
      origin: "app",
      providerId: "team-echo",
      model: "fake-model",
      reasoningLevel: "medium",
      permissionMode: "full",
      environment: { type: "project-default" },
      experimental_pluginContext: { team: { memberId: id } },
      prompt: "Before plugin upgrade",
    });
    await expect
      .poll(
        async () => (await sdk.threads.get({ threadId: thread.id })).status,
        { timeout: 30000 },
      )
      .toBe("idle");
    expect(
      await sdk.threads.getPluginMetadata({
        threadId: thread.id,
        pluginId: "team",
      }),
    ).toEqual({ memberId: id });
    const before = await rpc("state");
    browser = await chromium.launch({ headless: true });
    const upgradeContext = await browser.newContext();
    const page = await upgradeContext.newPage();
    diagnosticPage = page;
    await page.goto(`${url}/plugins/team/members`);
    const skip = page.getByRole("button", { name: "Skip setup", exact: true });
    const remember = page.getByRole("button", {
      name: "Remember Legacy administrator",
      exact: true,
    });
    await skip.or(remember).first().waitFor();
    if (await skip.isVisible()) {
      await skip.click();
      await page.goto(`${url}/plugins/team/members`);
    }
    await remember.click();
    await expect(
      page.getByRole("button", { name: "Edit my profile", exact: true }),
    ).toBeVisible();
    await page.goto(url);
    const upgradeSecond = await page.context().newPage();
    await upgradeSecond.goto(url);
    await copyCurrentPlugin();
    await runCli(["plugin", "build", livePlugin]);
    await runCli(["plugin", "reload", "team"]);
    const after = await rpc("state");
    expect(after.adminMemberId).toBe(id);
    expect(after.serverScope).toBe(before.serverScope);
    expect(await rpc("members_get", { memberId: id })).toMatchObject({
      memberId: id,
      displayName: "Admin",
      avatarId: "admin",
      createdAt: legacy.member.createdAt,
    });
    expect(await rpc("members_get", { memberId: ordinary.memberId })).toEqual(
      ordinary,
    );
    expect((await rpc("members_list", {})).members).toHaveLength(2);
    expect(
      await sdk.threads.getPluginMetadata({
        threadId: thread.id,
        pluginId: "team",
      }),
    ).toEqual({ memberId: id });
    expect(
      (await rpc("activity", { memberId: id, date: "today" })).items.some(
        (item) => item.threadId === thread.id,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", {
        name: "当前身份：Admin，切换身份",
        exact: true,
      }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole("dialog", { name: "选择团队身份", exact: true }),
    ).not.toBeVisible();
    await expect(
      upgradeSecond.getByRole("button", {
        name: "当前身份：Admin，切换身份",
        exact: true,
      }),
    ).toBeVisible();
    await openPicker(upgradeSecond);
    await upgradeSecond
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await openPicker(page);
    await expect(
      page.getByRole("button", { name: "编辑资料", exact: true }),
    ).toHaveCount(0);
    if (evidence)
      await page.screenshot({
        path: join(evidence, "upgraded-fixed-admin.png"),
      });
    console.log(
      `PASS: real plugin upgrade from ${upgradeFrom} preserves Admin UUID, server scope, ordinary profile, native thread metadata and activity; fixes only Admin presentation`,
    );
  } else {
    const state = await rpc("state");
    const initial = (await rpc("members_list", {})).members;
    expect(initial).toHaveLength(1);
    const admin = initial[0];
    expect(admin).toMatchObject({
      memberId: state.adminMemberId,
      displayName: "Admin",
      avatarId: "admin",
    });
    expect((await rpc("avatars_list")).length).toBe(21);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    context.on("page", (page) => {
      page.on("pageerror", (error) => console.error("Browser error:", error));
      page.on("console", (message) => {
        if (message.type() === "error")
          console.error("Browser console:", message.text());
      });
    });
    const page = await context.newPage();
    diagnosticPage = page;
    await enterApp(page);
    await expect(
      page.getByRole("dialog", { name: "选择团队身份", exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).not.toContain("/plugins/team/");
    if (evidence)
      await page.screenshot({
        path: join(evidence, "fresh-automatic-picker.png"),
      });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "选择团队身份", exact: true }),
    ).not.toBeVisible();
    await rpc("timezone_set", { timezone: "Asia/Shanghai" });
    await expect(
      page.getByRole("dialog", { name: "选择团队身份", exact: true }),
    ).not.toBeVisible();
    await openPicker(page);
    await page.getByRole("button", { name: "选择 Admin", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "当前身份：Admin，切换身份",
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", {
        name: "当前身份：Admin，切换身份",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "选择团队身份", exact: true }),
    ).not.toBeVisible();
    await openPicker(page);
    await expect(
      page.getByRole("button", { name: "编辑资料", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "创建成员", exact: true }).click();
    await expect(page.locator("fieldset button")).toHaveCount(20);
    await expect
      .poll(() =>
        page
          .locator("fieldset img")
          .evaluateAll((images) =>
            images.every((image) => image.complete && image.naturalWidth > 0),
          ),
      )
      .toBe(true);
    if (evidence)
      await page.screenshot({
        path: join(evidence, "twenty-ordinary-avatars.png"),
      });
    await page.getByLabel("成员姓名", { exact: true }).fill("Member");
    await page.getByRole("button", { name: "狐狸", exact: true }).click();
    await page.getByRole("button", { name: "创建成员", exact: true }).click();
    const other = (await rpc("members_list", { search: "Member" })).members[0];
    await expect(
      page.getByRole("button", { name: "选择 Member", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    const second = await context.newPage();
    await enterApp(second);
    await expect(
      second.getByRole("dialog", { name: "选择团队身份", exact: true }),
    ).not.toBeVisible();
    await openPicker(second);
    await second
      .getByRole("button", { name: "选择 Member", exact: true })
      .click();
    await expect(
      second.getByRole("dialog", { name: "选择团队身份", exact: true }),
    ).not.toBeVisible();
    await expect(
      second.getByRole("button", {
        name: "当前身份：Member，切换身份",
        exact: true,
      }),
    ).toBeVisible();
    await second.reload();
    await expect(
      second.getByRole("button", {
        name: "当前身份：Member，切换身份",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "当前身份：Admin，切换身份",
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", {
        name: "当前身份：Admin，切换身份",
        exact: true,
      }),
    ).toBeVisible();
    await openPicker(second);
    await second.getByRole("button", { name: "编辑资料", exact: true }).click();
    await second.getByLabel("成员姓名", { exact: true }).fill("Renamed");
    await second.getByRole("button", { name: "猫头鹰", exact: true }).click();
    await second.getByRole("button", { name: "保存资料", exact: true }).click();
    await second.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(
      second.getByRole("button", {
        name: "当前身份：Renamed，切换身份",
        exact: true,
      }),
    ).toBeVisible();
    await openPicker(page);
    await expect(
      page.getByRole("button", { name: "选择 Renamed", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    if (evidence)
      await second.screenshot({
        path: join(evidence, "persistent-current-identity.png"),
      });
    const sdk = new BBSdk({ baseUrl: url });
    expect(
      (await rpc("members_get", { memberId: other.memberId })).avatarId,
    ).toBe("owl");
    console.log(await runCli(["team", "list", "--json"]));
    console.log(
      "PASS: app-wide prompt, cancel recovery, default Admin, 20 ordinary avatars, persistent selection, independent windows and live profile display",
    );
    if (process.env.BB_TEAM_TEST_PROVIDER_DIR) {
      const host = (await sdk.hosts.list()).find(
        (host) => host.status === "connected",
      );
      const projectPath = join(data, "project");
      await mkdir(projectPath);
      const project = await sdk.projects.create({
        name: "Team identity acceptance",
        source: { type: "local_path", hostId: host.id, path: projectPath },
      });
      await sdk.threads.spawn({
        projectId: project.id,
        origin: "app",
        providerId: "team-echo",
        model: "fake-model",
        reasoningLevel: "medium",
        permissionMode: "full",
        environment: { type: "project-default" },
        prompt: "Unassigned seed",
      });
      const editor = (target) =>
        target.locator(
          '[data-app-composer-role="primary"] [contenteditable="true"]',
        );
      const submit = (target) =>
        target.locator(
          '[data-app-composer-role="primary"] button[data-promptbox-submit-action][type="submit"]',
        );
      await page.goto(`${url}/projects/${project.id}`);
      diagnosticPage = page;
      await expect(
        page.getByRole("button", {
          name: "当前身份：Admin，切换身份",
          exact: true,
        }),
      ).toBeVisible();
      await editor(page).fill("Admin native fixture");
      await expect(submit(page)).toBeEnabled();
      await submit(page).click();
      await page.waitForURL(/\/threads\//);
      const firstId = page.url().split("/threads/")[1].split(/[?#]/)[0];
      expect(
        await sdk.threads.getPluginMetadata({
          threadId: firstId,
          pluginId: "team",
        }),
      ).toEqual({ memberId: admin.memberId });
      await second.goto(`${url}/projects/${project.id}`);
      await editor(second).fill(
        "Member native fixture with a long descriptive title that must not push avatars or project labels outside the sidebar",
      );
      await expect(submit(second)).toBeEnabled();
      await submit(second).click();
      await second.waitForURL(/\/threads\//);
      const secondId = second.url().split("/threads/")[1].split(/[?#]/)[0];
      expect(
        await sdk.threads.getPluginMetadata({
          threadId: secondId,
          pluginId: "team",
        }),
      ).toEqual({ memberId: other.memberId });
      await expect(
        page.getByText("Response to: Admin native fixture", { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await openPicker(page);
      await page.getByText("更多选项", { exact: true }).click();
      await page
        .getByRole("button", { name: "仅此窗口选择 Renamed", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "选择团队身份", exact: true }),
      ).not.toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "当前身份：Renamed，切换身份",
          exact: true,
        }),
      ).toBeVisible();
      await page.goto(`${url}/projects/${project.id}/threads/${firstId}`);
      await page
        .getByText("Response to: Admin native fixture", { exact: true })
        .hover();
      await page
        .getByRole("button", { name: "Message actions", exact: true })
        .last()
        .click();
      console.log(
        "Fork source state",
        JSON.stringify(await sdk.threads.get({ threadId: firstId })),
      );
      await page
        .getByRole("menuitem", { name: "Fork into new thread", exact: true })
        .click();
      await page.waitForURL(
        (value) =>
          value.pathname.includes("/threads/") &&
          !value.pathname.endsWith(firstId),
      );
      const forkId = page.url().split("/threads/")[1].split(/[?#]/)[0];
      expect(
        await sdk.threads.getPluginMetadata({
          threadId: forkId,
          pluginId: "team",
        }),
      ).toEqual({ memberId: other.memberId });
      await editor(page).fill("Fork local suffix");
      await submit(page).click();
      await expect(
        page.getByText("Response to: Fork local suffix", { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      const forkReport = await rpc("activity", {
        mode: "details",
        memberId: other.memberId,
        threadId: forkId,
      });
      expect(
        forkReport.items.some((item) =>
          item.excerpt.includes("Fork local suffix"),
        ),
      ).toBe(true);
      expect(
        forkReport.items.some((item) =>
          item.excerpt.includes("Admin native fixture"),
        ),
      ).toBe(false);
      const nestedFork = await sdk.threads.fork({
        sourceThreadId: forkId,
        experimental_pluginContext: { team: { memberId: other.memberId } },
        input: [{ type: "text", text: "Nested fork suffix", mentions: [] }],
      });
      await expect
        .poll(
          async () =>
            (await sdk.threads.get({ threadId: nestedFork.id })).status,
          { timeout: 30000 },
        )
        .toBe("idle");
      const nestedReport = await rpc("activity", {
        mode: "details",
        memberId: other.memberId,
        threadId: nestedFork.id,
      });
      expect(
        nestedReport.items.some((item) =>
          item.excerpt.includes("Nested fork suffix"),
        ),
      ).toBe(true);
      expect(
        nestedReport.items.some(
          (item) =>
            item.excerpt.includes("Fork local suffix") ||
            item.excerpt.includes("Admin native fixture"),
        ),
      ).toBe(false);
      await sdk.threads.archive({ threadId: nestedFork.id });
      const archivedReport = await rpc("activity", {
        memberId: other.memberId,
        projectId: project.id,
      });
      expect(
        archivedReport.items.some((item) => item.threadId === nestedFork.id),
      ).toBe(true);
      console.log(
        "PASS: multilevel fork excludes inherited prefixes and archived local activity remains queryable",
      );
      console.log(
        "PASS: manual fork attribution and local-only retained evidence",
      );
      await page
        .getByRole("button", { name: /^Provider, model and reasoning/ })
        .click();
      await page
        .getByRole("button", { name: "Handoff to new thread", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await editor(page).fill("Handoff fixture");
      await submit(page).click();
      await page.waitForURL(
        (value) =>
          value.pathname.includes("/threads/") &&
          !value.pathname.endsWith(forkId),
      );
      const handoffId = page.url().split("/threads/")[1].split(/[?#]/)[0];
      expect(
        await sdk.threads.getPluginMetadata({
          threadId: handoffId,
          pluginId: "team",
        }),
      ).toEqual({ memberId: other.memberId });
      expect(
        (await sdk.threads.get({ threadId: handoffId })).originKind,
      ).toBeNull();
      await openPicker(page);
      await page.getByText("更多选项", { exact: true }).click();
      await page
        .getByRole("button", { name: "此窗口暂不选择身份", exact: true })
        .click();
      await page.goto(`${url}/projects/${project.id}`);
      await expect(
        page.getByRole("dialog", { name: "选择团队身份", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await editor(page).fill("Unassigned native fixture");
      await submit(page).click();
      await page.waitForURL(/\/threads\//);
      const unassignedId = page.url().split("/threads/")[1].split(/[?#]/)[0];
      expect(
        await sdk.threads.getPluginMetadata({
          threadId: unassignedId,
          pluginId: "team",
        }),
      ).toEqual({});
      await page.evaluate((scope) => {
        sessionStorage.setItem(
          `bb-plugin-team:identity:v1:${JSON.stringify([location.origin, scope])}`,
          JSON.stringify("00000000-0000-4000-8000-000000000000"),
        );
      }, state.serverScope);
      await page.goto(`${url}/projects/${project.id}`);
      await expect(
        page.getByText("已保存的身份失效，请重新选择。", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await editor(page).fill("Preserve invalid identity draft");
      const rejected = page.waitForResponse(
        (response) =>
          response.url() === `${url}/api/v1/threads` &&
          response.request().method() === "POST",
      );
      await submit(page).click();
      expect((await rejected).ok()).toBe(false);
      await expect(editor(page)).toHaveText("Preserve invalid identity draft");
      await expect(
        page
          .getByText("Creation context failed: team", { exact: false })
          .first(),
      ).toBeVisible();
      if (evidence)
        await page.screenshot({
          path: join(evidence, "invalid-identity-draft.png"),
        });
      console.log(
        "PASS: native handoff attribution, explicit null and failed prepare preserves draft",
      );
      await openPicker(page);
      await page
        .getByRole("button", { name: "选择 Admin", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "选择团队身份", exact: true }),
      ).not.toBeVisible();
      const report = await rpc("activity", {
        memberId: admin.memberId,
        date: "today",
      });
      expect(report.items.some((item) => item.threadId === firstId)).toBe(true);
      expect(report.items.some((item) => item.threadId === secondId)).toBe(
        false,
      );
      if (evidence)
        await writeFile(
          join(evidence, "activity.json"),
          JSON.stringify(report, null, 2),
        );
      console.log(
        "PASS: native attribution and bounded activity on normal deterministic provider protocol (not paid AI)",
      );
      const childPath = join(data, "child-project");
      await mkdir(childPath);
      const childProject = await sdk.projects.create({
        name: "Child project",
        source: { type: "local_path", hostId: host.id, path: childPath },
      });
      const childThread = await sdk.threads.spawn({
        projectId: childProject.id,
        parentThreadId: firstId,
        origin: "app",
        providerId: "team-echo",
        model: "fake-model",
        reasoningLevel: "medium",
        permissionMode: "full",
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: childPath },
        },
        experimental_pluginContext: { team: { memberId: other.memberId } },
        prompt: "Cross-group child evidence",
      });
      await sdk.threads.pin({ threadId: secondId });
      await page.goto(`${url}/projects/${project.id}/threads/${firstId}`);
      await runCli([
        "thread-list",
        "prefs",
        "set",
        "organizationMode",
        "team/members",
      ]);
      await expect(
        page.getByRole("button", {
          name: "Collapse Admin section",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.locator(
          '[data-sidebar-rename-row] [aria-label^="Thread member:"]',
        ),
      ).toHaveCount(0);
      await expect(
        page.locator("[data-sidebar-thread-cross-project]").first(),
      ).toBeVisible();
      const expandChild = page.getByRole("button", {
        name: "Expand Admin native fixture threads",
        exact: true,
      });
      if (await expandChild.isVisible()) await expandChild.click();
      const childRow = page
        .locator('[data-sidebar-rename-row][role="button"]')
        .filter({
          has: page.locator(`[data-sidebar-thread-id="${childThread.id}"]`),
        });
      await expect(childRow).toBeVisible();
      await expect(
        childRow.getByLabel("In project Child project", { exact: true }),
      ).toBeVisible();
      await expect(
        childRow.locator('[aria-label^="Thread member:"]'),
      ).toHaveCount(0);
      const pinnedRow = page
        .locator('[data-sidebar-rename-row][role="button"]')
        .filter({ has: page.locator(`[data-sidebar-thread-id="${secondId}"]`) })
        .first();
      await expect(
        pinnedRow.getByLabel("In project Team identity acceptance", {
          exact: true,
        }),
      ).toBeVisible();
      if (evidence)
        await page.screenshot({ path: join(evidence, "member-groups.png") });
      for (const mode of ["chronological", "project", "machine"]) {
        await runCli(["thread-list", "prefs", "set", "organizationMode", mode]);
        const avatar = page
          .getByLabel("Thread member: Admin", { exact: true })
          .first();
        await expect(avatar).toBeVisible();
        expect(await avatar.textContent()).toBe("");
        await expect(avatar).toHaveAttribute("title", "Thread member: Admin");
        expect(
          await avatar.evaluate((element) => {
            const row = element.closest("[data-sidebar-rename-row]");
            const title = row?.querySelector(".bb-thread-title");
            const provider = row?.querySelector(
              "[data-sidebar-thread-provider]",
            );
            return Boolean(
              title &&
              element.compareDocumentPosition(title) &
                Node.DOCUMENT_POSITION_FOLLOWING &&
              (!provider ||
                element.compareDocumentPosition(provider) &
                  Node.DOCUMENT_POSITION_FOLLOWING),
            );
          }),
        ).toBe(true);
        await expect(
          page.getByLabel("Thread member: Unassigned", { exact: true }),
        ).toHaveCount(0);
        const dimensions = await page
          .locator('[data-sidebar-thread-decorations="leading"] [role="img"]')
          .evaluateAll((elements) =>
            elements.map((element) => ({
              name: element.getAttribute("aria-label"),
              container: element.parentElement.getBoundingClientRect().width,
              anchor: element.getBoundingClientRect().width,
              image:
                element.querySelector("img")?.getBoundingClientRect().width ??
                0,
            })),
          );
        clippedAvatars.push(
          ...dimensions
            .filter(
              (item) =>
                item.image < 15.5 ||
                item.container + 0.5 < item.image ||
                item.anchor + 0.5 < item.image,
            )
            .map((item) => ({ mode, ...item })),
        );
        if (evidence) {
          await writeFile(
            join(evidence, `avatar-dimensions-${mode}.json`),
            JSON.stringify(dimensions, null, 2),
          );
          await page.screenshot({
            path: join(evidence, `leading-avatar-${mode}.png`),
          });
        }
      }
      console.log(
        "PASS: member groups omit row member decorations and show native projects; chronological/project/machine render only leading member avatars before provider/title",
      );
    }
    await runCli(["plugin", "disable", "team"]);
    await expect(page.getByRole("button", { name: /^当前身份：/ })).toHaveCount(
      0,
    );
    await runCli(["plugin", "enable", "team"]);
    await expect(
      page.getByRole("button", {
        name: "当前身份：Admin，切换身份",
        exact: true,
      }),
    ).toBeVisible({ timeout: 15000 });
    expect((await rpc("state")).adminMemberId).toBe(admin.memberId);
    expect(
      (await rpc("members_get", { memberId: other.memberId })).displayName,
    ).toBe("Renamed");
    console.log(
      "PASS: disable/enable cleans identity UI and retains members and selection",
    );
    await browser.close();
    browser = null;
    for (let index = 0; index < 22; index++)
      await rpc("members_create", {
        actorMemberId: admin.memberId,
        displayName: `Scroll member ${index}`,
        avatarId: "cat",
      });
    for (const engine of [chromium, webkit]) {
      browser = await engine.launch({ headless: true });
      const mobile = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      const page = await mobile.newPage();
      diagnosticPage = page;
      await enterApp(page);
      await expect(
        page.locator("[data-persistent-drawer-content]"),
      ).toBeInViewport();
      if (evidence)
        await page.screenshot({
          path: join(evidence, `picker-${engine.name()}.png`),
        });
      await page
        .getByRole("button", { name: "下一页", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole("button", { name: "下一页", exact: true }),
      ).toBeInViewport();
      await page.getByRole("button", { name: "下一页", exact: true }).click();
      await page.getByLabel("搜索成员", { exact: true }).fill("Renamed");
      await page
        .getByRole("button", { name: "选择 Renamed", exact: true })
        .click();
      await expect(
        page.locator("[data-persistent-drawer-content]"),
      ).not.toBeInViewport();
      await expect(
        page.getByRole("button", {
          name: "当前身份：Renamed，切换身份",
          exact: true,
        }),
      ).toBeVisible();
      await openPicker(page);
      await page.getByRole("button", { name: "编辑资料", exact: true }).click();
      await expect(page.getByLabel("成员姓名", { exact: true })).toBeVisible();
      if (evidence)
        await page.screenshot({
          path: join(evidence, `profile-${engine.name()}.png`),
        });
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(
        page.locator("[data-persistent-drawer-content]"),
      ).not.toBeInViewport();
      await page
        .getByRole("button", { name: /^Toggle sidebar(?: \(|$)/ })
        .click();
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "Search threads", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "Search threads", exact: true })
        .fill("fixture");
      await expect(
        page.getByRole("combobox", { name: "Search threads", exact: true }),
      ).toHaveValue("fixture");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(page.locator("main[data-sidebar-shelf]")).toHaveAttribute(
        "data-sidebar-shelf",
        "closed",
      );
      await expect(
        page.getByRole("button", {
          name: "当前身份：Renamed，切换身份",
          exact: true,
        }),
      ).toBeVisible();
      if (evidence)
        await page.screenshot({
          path: join(evidence, `closed-sidebar-identity-${engine.name()}.png`),
        });
      const identityBounds = await page
        .getByRole("button", {
          name: "当前身份：Renamed，切换身份",
          exact: true,
        })
        .boundingBox();
      const composerBounds = await page
        .locator('[data-app-composer-role="primary"]')
        .boundingBox();
      expect(identityBounds.y + identityBounds.height).toBeLessThan(
        composerBounds.y,
      );
      await openPicker(page);
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      console.log(
        `PASS: ${engine.name()} 390x844 picker/profile close restores native Search; identity accessible with sidebar closed`,
      );
      await browser.close();
      browser = null;
    }
    if (evidence)
      await writeFile(
        join(evidence, "clipped-avatars.json"),
        JSON.stringify(clippedAvatars, null, 2),
      );
    expect(clippedAvatars).toEqual([]);
    console.log(`PASS: identity/Admin integration on BB ${provenance.source}`);
  }
} catch (error) {
  if (diagnosticPage && !diagnosticPage.isClosed()) {
    try {
      console.error(
        "Browser state:",
        diagnosticPage.url(),
        await diagnosticPage.locator("body").innerText(),
      );
      if (evidence) {
        await diagnosticPage.screenshot({
          path: join(evidence, "failure.png"),
        });
        await writeFile(
          join(evidence, "failure.html"),
          await diagnosticPage.content(),
        );
      }
    } catch {}
  }
  throw error;
} finally {
  if (browser) await browser.close();
  await Promise.all([stopGroup(daemon), stopGroup(child)]);
  await rm(data, { recursive: true, force: true });
}
