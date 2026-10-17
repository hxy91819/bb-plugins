import { test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../server.js";
import { rpcContract } from "../src/contracts.js";
import { createMemberService, migrations } from "../src/members.js";
import { createTeamSdkClient } from "../src/client.js";
import { loadAvatarAssets } from "../src/avatars.js";
const avatars = loadAvatarAssets().map(({ id }) => ({ id }));
function memory() {
  const db = new Database(":memory:");
  db.transaction(() => migrations.forEach((sql) => db.exec(sql)))();
  return {
    db,
    service: createMemberService(db, avatars, () => {}),
  };
}
test("failed initialization rolls back its member, retry wins, and later initialization creates no orphan", () => {
  const { db, service } = memory();
  try {
    db.exec(
      "CREATE TRIGGER reject_team BEFORE INSERT ON team BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    expect(() => service.initialize({})).toThrow("injected failure");
    expect(db.prepare("SELECT COUNT(*) AS count FROM members").get()).toEqual({
      count: 0,
    });
    db.exec("DROP TRIGGER reject_team");
    const first = service.initialize({});
    expect(first.status).toBe("initialized");
    expect(service.initialize({}).status).toBe("already_initialized");
    expect(service.list({}).members).toHaveLength(1);
  } finally {
    db.close();
  }
});
test("independent SQLite connections race for one administrator", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-team-race-"));
  const path = join(dir, "members.db");
  const db = new Database(path);
  db.pragma("journal_mode=WAL");
  migrations.forEach((sql) => db.exec(sql));
  db.close();
  const code = `const {parentPort,workerData}=require('node:worker_threads');const DB=require('better-sqlite3');(async()=>{const {tsImport}=await import('tsx/esm/api');const {createMemberService}=await tsImport(workerData.service,workerData.service);const db=new DB(workerData.path);db.pragma('busy_timeout=5000');const service=createMemberService(db,workerData.avatars,()=>{});parentPort.postMessage('ready');parentPort.once('message',()=>{try{parentPort.postMessage(service.initialize({}).status);}catch(e){parentPort.postMessage(String(e));}finally{db.close();}});})();`;
  try {
    const workers = [0, 1].map(
      () =>
        new Worker(code, {
          eval: true,
          workerData: {
            path,
            service: new URL("../src/members.ts", import.meta.url).href,
            avatars: avatars,
          },
        }),
    );
    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            w.once("message", () => resolve());
            w.once("error", reject);
          }),
      ),
    );
    const results = workers.map(
      (w) =>
        new Promise<string>((resolve, reject) => {
          w.once("message", resolve);
          w.once("error", reject);
        }),
    );
    workers.forEach((w) => w.postMessage("go"));
    expect((await Promise.all(results)).sort()).toEqual([
      "already_initialized",
      "initialized",
    ]);
    const check = new Database(path);
    expect(
      check.prepare("SELECT COUNT(*) AS count FROM members").get(),
    ).toEqual({ count: 1 });
    expect(check.prepare("SELECT COUNT(*) AS count FROM team").get()).toEqual({
      count: 1,
    });
    check.close();
    await Promise.all(workers.map((w) => w.terminate()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("member service enforces create policy, stable IDs, literal search, ambiguity and input boundaries", () => {
  const { db, service } = memory();
  try {
    const initialized = service.initialize({});
    if (initialized.status !== "initialized")
      throw Error("initialization failed");
    const admin = initialized.member;
    expect(admin.displayName).toBe("Admin");
    expect(admin.avatarId).toBe("admin");
    const a = service.create({
      actorMemberId: admin.memberId,
      displayName: "同名",
      avatarId: "fox",
    });
    const b = service.create({
      actorMemberId: admin.memberId,
      displayName: "同名",
      avatarId: "owl",
    });
    expect(() =>
      service.create({
        actorMemberId: a.memberId,
        displayName: "拒绝",
        avatarId: "cat",
      }),
    ).toThrow("admin_required");
    const resolved = service.resolve({ name: "同名", limit: 1, cursor: null });
    expect(resolved.status).toBe("ambiguous");
    expect(resolved.members).toHaveLength(1);
    expect(resolved.nextCursor).not.toBeNull();
    expect(
      service.resolve({ name: "同名", limit: 1, cursor: resolved.nextCursor })
        .members,
    ).toHaveLength(1);
    const renamed = service.updateSelf({
      memberId: a.memberId,
      displayName: "更名",
      avatarId: "frog",
    });
    expect(renamed.memberId).toBe(a.memberId);
    expect(service.get(a.memberId)?.avatarId).toBe("frog");
    expect(service.get(b.memberId)?.displayName).toBe("同名");
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const page = service.list({ limit: 1, cursor });
      all.push(...page.members.map((m) => m.memberId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(all).size).toBe(3);
    service.create({
      actorMemberId: admin.memberId,
      displayName: "100%_literal",
      avatarId: "cat",
    });
    expect(
      service.list({ search: "%_" }).members.map((m) => m.displayName),
    ).toEqual(["100%_literal"]);
    for (const displayName of ["", " ".repeat(2), "字".repeat(81)])
      expect(() =>
        service.create({
          actorMemberId: admin.memberId,
          displayName,
          avatarId: "cat",
        }),
      ).toThrow();
    expect(
      service.create({
        actorMemberId: admin.memberId,
        displayName: "猫".repeat(80),
        avatarId: "cat",
      }).displayName,
    ).toHaveLength(80);
    expect(() =>
      service.updateSelf({
        memberId: a.memberId,
        displayName: "无效头像",
        avatarId: "missing",
      }),
    ).toThrow("invalid_avatar");
    expect(() => service.list({ limit: 101 })).toThrow();
    expect(service.validate(null)).toEqual({ valid: true, member: null });
  } finally {
    db.close();
  }
});
test("real plugin entry shares validated RPC, script SDK, CLI, settings and real avatar HTTP behavior", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "team" });
  await plugin(bb);
  try {
    harness.inspection.sdk.stub(
      "plugins.callRpc",
      async (args: { method: string; input: unknown }) =>
        harness.behavior.callRpc(args.method, args.input),
    );
    const sdk = createTeamSdkClient(bb.sdk);
    const initialized = rpcContract.initialize.output.parse(
      await harness.behavior.callRpc("initialize", {}),
    );
    if (initialized.status !== "already_initialized")
      throw Error("default admin missing");
    const cli = await harness.behavior.runCli([
      "create",
      "--actor",
      initialized.adminMemberId,
      "--name",
      "Member",
      "--avatar",
      "panda",
      "--json",
    ]);
    expect(cli.exitCode).toBe(0);
    const member = rpcContract.members_create.output.parse(
      JSON.parse(cli.stdout),
    );
    expect(
      await harness.behavior.runCli([
        "create",
        "--actor",
        member.memberId,
        "--name",
        "Denied",
      ]),
    ).toMatchObject({ exitCode: 1, stderr: "admin_required" });
    expect(await sdk.get(member.memberId)).toEqual(member);
    expect((await sdk.list()).members).toHaveLength(2);
    expect(
      (
        await harness.behavior.runCli([
          "update-self",
          "--member",
          member.memberId,
          "--name",
          "Changed",
          "--avatar",
          "koala",
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      rpcContract.members_get.output.parse(
        await harness.behavior.callRpc("members_get", {
          memberId: member.memberId,
        }),
      )?.displayName,
    ).toBe("Changed");
    await expect(
      harness.behavior.callRpc("members_updateSelf", {
        memberId: member.memberId,
        actorMemberId: initialized.adminMemberId,
        displayName: "Bad",
        avatarId: "cat",
      }),
    ).rejects.toThrow();
    await expect(
      harness.behavior.callRpc("timezone_set", {
        timezone: "Invalid/Timezone",
      }),
    ).rejects.toThrow();
    expect(
      await harness.behavior.callRpc("timezone_set", {
        timezone: "Asia/Shanghai",
      }),
    ).toEqual({ timezone: "Asia/Shanghai" });
    await harness.behavior.setSettings({ timezone: "Europe/London" });
    expect(
      rpcContract.state.output.parse(await harness.behavior.callRpc("state"))
        .timezone,
    ).toBe("Europe/London");
    const avatars = rpcContract.avatars_list.output.parse(
      await harness.behavior.callRpc("avatars_list"),
    );
    expect(
      JSON.parse((await harness.behavior.runCli(["avatars", "--json"])).stdout),
    ).toEqual(avatars);
    for (const avatar of avatars) {
      const response = await harness.behavior.fetchHttp(
        "GET",
        `/avatars/${avatar.file}`,
      );
      expect(response.headers.get("content-type")).toBe("image/png");
      const cached = await harness.behavior.fetchHttp(
        "GET",
        `/avatars/${avatar.file}`,
        { headers: { "If-None-Match": response.headers.get("etag")! } },
      );
      expect(cached.status).toBe(304);
      expect(
        createHash("sha256")
          .update(Buffer.from(await response.arrayBuffer()))
          .digest("hex"),
      ).toBe(
        createHash("sha256")
          .update(
            readFileSync(
              new URL(`../assets/avatars/${avatar.file}`, import.meta.url),
            ),
          )
          .digest("hex"),
      );
    }
    expect(
      harness.inspection.realtimeSignals.some(
        (signal) => signal.channel === "members.changed",
      ),
    ).toBe(true);
    expect(
      rpcContract.members_get.output.parse(
        await harness.behavior.callRpc("members_get", {
          memberId: member.memberId,
        }),
      )?.displayName,
    ).toBe("Changed");
  } finally {
    await harness.lifecycle.dispose();
  }
});
test("public package stays inside declared public SDK boundary", async () => {
  const result = await experimental_scanPublicSdkOnly(
    fileURLToPath(new URL("../", import.meta.url)),
    {
      allow: [
        /^(vitest(\/config)?|tsx\/esm\/api|typescript-eslint|better-sqlite3|react|react-dom|@playwright\/test|bb-app|@testing-library\/react|class-variance-authority|clsx|tailwind-merge|cron-parser)$/,
        /^@radix-ui\//,
      ],
    },
  );
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});

test("upgrade preserves the administrator UUID, members and timestamps while fixing only administrator presentation", () => {
  const db = new Database(":memory:");
  try {
    migrations.slice(0, 4).forEach((sql) => db.exec(sql));
    const adminId = "00000000-0000-4000-8000-000000000001";
    const otherId = "00000000-0000-4000-8000-000000000002";
    db.prepare("INSERT INTO members VALUES(?,?,?,?,?)").run(
      adminId,
      "Old admin",
      "cat",
      10,
      20,
    );
    db.prepare("INSERT INTO members VALUES(?,?,?,?,?)").run(
      otherId,
      "Unchanged",
      "fox",
      30,
      40,
    );
    db.prepare("INSERT INTO team VALUES(1,?)").run(adminId);
    migrations.slice(4).forEach((sql) => db.exec(sql));
    const service = createMemberService(db, avatars, () => {});
    expect(service.initialize({})).toEqual({
      status: "already_initialized",
      adminMemberId: adminId,
    });
    expect(service.get(adminId)).toEqual({
      memberId: adminId,
      displayName: "Admin",
      avatarId: "admin",
      createdAt: 10,
      updatedAt: 20,
    });
    expect(service.get(otherId)).toEqual({
      memberId: otherId,
      displayName: "Unchanged",
      avatarId: "fox",
      createdAt: 30,
      updatedAt: 40,
    });
    expect(service.list({}).members).toHaveLength(2);
    expect(() =>
      service.updateSelf({
        memberId: adminId,
        displayName: "Renamed",
        avatarId: "cat",
      }),
    ).toThrow("admin_profile_fixed");
    expect(() =>
      service.create({
        actorMemberId: adminId,
        displayName: "Ordinary",
        avatarId: "admin",
      }),
    ).toThrow("invalid_avatar");
    expect(() =>
      service.updateSelf({
        memberId: otherId,
        displayName: "Ordinary",
        avatarId: "admin",
      }),
    ).toThrow("invalid_avatar");
    expect(() => service.initialize({ displayName: "Ignored?" })).toThrow();
    expect(service.get(adminId)?.displayName).toBe("Admin");
  } finally {
    db.close();
  }
});

test("fresh plugin automatically exposes exactly one fixed Admin and rejects obsolete initialization and profile changes over RPC/CLI", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "team" });
  await plugin(bb);
  try {
    const state = rpcContract.state.output.parse(
      await harness.behavior.callRpc("state"),
    );
    const members = rpcContract.members_list.output.parse(
      await harness.behavior.callRpc("members_list", {}),
    ).members;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      memberId: state.adminMemberId,
      displayName: "Admin",
      avatarId: "admin",
    });
    await expect(
      harness.behavior.callRpc("initialize", { displayName: "Other" }),
    ).rejects.toThrow();
    expect(
      await harness.behavior.runCli(["initialize", "--name", "Other"]),
    ).toMatchObject({ exitCode: 1 });
    expect(
      await harness.behavior.runCli(["initialize", "--avatar", "fox"]),
    ).toMatchObject({ exitCode: 1 });
    expect(
      await harness.behavior.runCli(["initialize", "--json"]),
    ).toMatchObject({ exitCode: 0 });
    await expect(
      harness.behavior.callRpc("members_updateSelf", {
        memberId: state.adminMemberId,
        displayName: "Other",
        avatarId: "cat",
      }),
    ).rejects.toThrow("admin_profile_fixed");
    expect(
      await harness.behavior.runCli([
        "update-self",
        "--member",
        state.adminMemberId!,
        "--name",
        "Other",
      ]),
    ).toMatchObject({ exitCode: 1, stderr: "admin_profile_fixed" });
    const list = rpcContract.avatars_list.output.parse(
      await harness.behavior.callRpc("avatars_list"),
    );
    expect(list.filter((a) => a.id !== "admin")).toHaveLength(20);
    expect(list.filter((a) => a.id === "admin")).toHaveLength(1);
  } finally {
    await harness.lifecycle.dispose();
  }
});
