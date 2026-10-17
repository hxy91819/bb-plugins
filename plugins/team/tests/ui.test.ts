// @vitest-environment jsdom
import { test, expect, beforeAll, afterAll } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import { rpcContract } from "../src/contracts.js";
// jsdom has no native dialog layout; browser smoke verifies focus/inert cleanup.
const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
async function setup(
  options: { savedId?: string; validationGate?: () => Promise<void> } = {},
) {
  const { bb, harness } = createFakePluginHost({ pluginId: "team" });
  await plugin(bb);
  if (options.savedId) {
    const state = rpcContract.state.output.parse(
      await harness.behavior.callRpc("state"),
    );
    localStorage.setItem(
      `bb-plugin-team:identity:v1:${JSON.stringify([location.origin, state.serverScope])}`,
      JSON.stringify(options.savedId),
    );
  }
  const app = await loadPluginApp(() => import("../app.js"));
  const slot = renderSlot(
    app.appOverlays[0]!,
    {},
    {
      pluginId: "team",
      rpc: {
        state: async () =>
          rpcContract.state.output.parse(
            await harness.behavior.callRpc("state"),
          ),
        avatars_list: async () =>
          rpcContract.avatars_list.output.parse(
            await harness.behavior.callRpc("avatars_list"),
          ),
        initialize: async (input) =>
          rpcContract.initialize.output.parse(
            await harness.behavior.callRpc("initialize", input),
          ),
        members_list: async (input) =>
          rpcContract.members_list.output.parse(
            await harness.behavior.callRpc("members_list", input),
          ),
        identity_validate: async (input) => {
          await options.validationGate?.();
          return rpcContract.identity_validate.output.parse(
            await harness.behavior.callRpc("identity_validate", input),
          );
        },
        members_create: async (input) =>
          rpcContract.members_create.output.parse(
            await harness.behavior.callRpc("members_create", input),
          ),
        members_updateSelf: async (input) =>
          rpcContract.members_updateSelf.output.parse(
            await harness.behavior.callRpc("members_updateSelf", input),
          ),
        timezone_set: async (input) =>
          rpcContract.timezone_set.output.parse(
            await harness.behavior.callRpc("timezone_set", input),
          ),
      },
    },
  );
  return { harness, slot };
}
test("fresh team prompts once, cancel stays dismissed, manual selection persists and Admin has no edit form", async () => {
  const { harness, slot } = await setup();
  try {
    await slot.findByRole("button", { name: "选择 Admin" });
    fireEvent.click(slot.getByRole("button", { name: "关闭" }));
    await slot.behavior.emitRealtime("members.changed", null);
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    fireEvent.click(slot.getByRole("button", { name: "选择身份" }));
    fireEvent.click(await slot.findByRole("button", { name: "选择 Admin" }));
    const trigger = await slot.findByRole("button", {
      name: "当前身份：Admin，切换身份",
    });
    fireEvent.click(trigger);
    await slot.findByRole("button", { name: "创建成员" });
    expect(slot.queryByRole("button", { name: "编辑资料" })).toBeNull();
    expect(slot.queryByLabelText("成员姓名")).toBeNull();
    const state = rpcContract.state.output.parse(
      await harness.behavior.callRpc("state"),
    );
    const key = `bb-plugin-team:identity:v1:${JSON.stringify([location.origin, state.serverScope])}`;
    expect(JSON.parse(localStorage.getItem(key)!)).toBe(state.adminMemberId);
    expect(JSON.parse(sessionStorage.getItem(key)!)).toBe(state.adminMemberId);
  } finally {
    slot.lifecycle.unmount();
    await harness.lifecycle.dispose();
  }
});
test("ordinary member display refreshes after signals and reconnect while editing drafts survive", async () => {
  const { harness, slot } = await setup();
  try {
    await slot.findByRole("button", { name: "选择 Admin" });
    const state = rpcContract.state.output.parse(
      await harness.behavior.callRpc("state"),
    );
    const member = rpcContract.members_create.output.parse(
      await harness.behavior.callRpc("members_create", {
        actorMemberId: state.adminMemberId,
        displayName: "Member",
        avatarId: "cat",
      }),
    );
    await slot.behavior.emitRealtime("members.changed", null);
    fireEvent.click(await slot.findByRole("button", { name: "选择 Member" }));
    fireEvent.click(
      await slot.findByRole("button", { name: "当前身份：Member，切换身份" }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "编辑资料" }));
    fireEvent.change(slot.getByLabelText("成员姓名"), {
      target: { value: "Unsaved profile" },
    });
    fireEvent.click(slot.getByRole("button", { name: "狐狸" }));
    await harness.behavior.callRpc("members_updateSelf", {
      memberId: member.memberId,
      displayName: "Updated",
      avatarId: "owl",
    });
    await slot.behavior.emitRealtime("members.changed", null);
    await slot.behavior.emitRealtime("settings.changed", null);
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() =>
      expect((slot.getByLabelText("成员姓名") as HTMLInputElement).value).toBe(
        "Unsaved profile",
      ),
    );
    expect(
      slot.getByRole("button", { name: "狐狸" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "返回身份选择" }));
    await slot.findByRole("button", { name: "选择 Updated" });
    fireEvent.click(slot.getByRole("button", { name: "关闭" }));
    await slot.findByRole("button", { name: "当前身份：Updated，切换身份" });
  } finally {
    slot.lifecycle.unmount();
    await harness.lifecycle.dispose();
  }
});
test("Admin creation draft and independent timezone errors survive realtime without another administrator", async () => {
  const { harness, slot } = await setup();
  try {
    fireEvent.click(await slot.findByRole("button", { name: "选择 Admin" }));
    fireEvent.click(
      await slot.findByRole("button", { name: "当前身份：Admin，切换身份" }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "创建成员" }));
    fireEvent.change(slot.getByLabelText("成员姓名"), {
      target: { value: "Unsaved new member" },
    });
    await slot.behavior.emitRealtime("members.changed", null);
    await waitFor(() =>
      expect((slot.getByLabelText("成员姓名") as HTMLInputElement).value).toBe(
        "Unsaved new member",
      ),
    );
    expect(slot.getAllByRole("button", { pressed: false })).toHaveLength(19);
    fireEvent.click(slot.getByRole("button", { name: "返回身份选择" }));
    fireEvent.click(slot.getByText("更多选项"));
    fireEvent.change(slot.getByLabelText("团队时区"), {
      target: { value: "Invalid/Timezone" },
    });
    fireEvent.click(slot.getByRole("button", { name: "保存时区" }));
    await slot.findByRole("alert");
    expect(
      rpcContract.members_list.output.parse(
        await harness.behavior.callRpc("members_list", {}),
      ).members,
    ).toHaveLength(1);
    fireEvent.change(slot.getByLabelText("团队时区"), {
      target: { value: "Asia/Shanghai" },
    });
    fireEvent.click(slot.getByRole("button", { name: "保存时区" }));
    await waitFor(async () =>
      expect(
        rpcContract.state.output.parse(await harness.behavior.callRpc("state"))
          .timezone,
      ).toBe("Asia/Shanghai"),
    );
  } finally {
    slot.lifecycle.unmount();
    await harness.lifecycle.dispose();
  }
});

test("loading and validation errors do not become unassigned; invalid saved identity prompts only after confirmed response", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  const { harness, slot } = await setup({
    savedId: "00000000-0000-4000-8000-000000000000",
    validationGate: async () => {
      await gate;
      if (fail) throw Error("offline fixture");
    },
  });
  try {
    await slot.findByRole("button", { name: "正在加载身份…" });
    expect(slot.queryByRole("dialog")).toBeNull();
    release();
    fireEvent.click(await slot.findByRole("button", { name: "身份加载失败" }));
    await slot.findByText("无法确认当前身份。");
    fail = false;
    fireEvent.click(slot.getByRole("button", { name: "重试" }));
    await slot.findByText("已保存的身份失效，请重新选择。");
    fireEvent.click(slot.getByRole("button", { name: "关闭" }));
    await slot.behavior.emitRealtime("members.changed", null);
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  } finally {
    release();
    slot.lifecycle.unmount();
    await harness.lifecycle.dispose();
  }
});

test("malformed saved identity opens the picker rather than becoming a permanent transport error", async () => {
  const { harness, slot } = await setup({ savedId: "obsolete-invalid-id" });
  try {
    await slot.findByText("已保存的身份失效，请重新选择。");
    fireEvent.click(await slot.findByRole("button", { name: "选择 Admin" }));
    await slot.findByRole("button", { name: "当前身份：Admin，切换身份" });
  } finally {
    slot.lifecycle.unmount();
    await harness.lifecycle.dispose();
  }
});
