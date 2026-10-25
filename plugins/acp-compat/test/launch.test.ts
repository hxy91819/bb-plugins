import { describe, expect, it } from "vitest";
import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { wrapLaunch } from "../src/launch.js";

describe("host-local launch wrapping", () => {
  it("translates the SDK's default permission insertion index before Node arguments", () => {
    const original = experimental_acpLaunchSpecSchema.parse({
      displayName: "Example",
      command: "agent",
      args: ["--acp"],
      env: {},
      permissionCli: { full: ["--full"] },
    });
    const wrapped = wrapLaunch(
      original,
      "codebuddy",
      "/node",
      "/plugin/host.js",
    );
    const args = [...wrapped.args];
    args.splice(
      wrapped.permissionCli!.insertAfterArgs!,
      0,
      ...wrapped.permissionCli!.full!,
    );
    expect(args).toEqual([
      "/plugin/host.js",
      "--acp-compat-proxy=codebuddy",
      "agent",
      "--full",
      "--acp",
    ]);
  });
  it("preserves execution settings and translates permission and discovery argument positions", () => {
    const original = experimental_acpLaunchSpecSchema.parse({
      displayName: "Example",
      command: "agent",
      args: ["entry.js", "--acp"],
      env: { EXAMPLE: "value" },
      cwd: "/workspace",
      permissionCli: {
        full: ["--full"],
        workspaceWrite: ["--workspace"],
        insertAfterArgs: 1,
      },
      modelCli: {
        listArgs: ["entry.js", "--list-models"],
        selectFlag: "--model",
        primaryModels: ["model-a"],
      },
      nativeSkillRoots: { user: [".skills"], project: [] },
    });
    const wrapped = wrapLaunch(
      original,
      "codebuddy",
      "/node",
      "/plugin/host.js",
    );
    expect(wrapped.args).toEqual([
      "/plugin/host.js",
      "--acp-compat-proxy=codebuddy",
      "agent",
      "entry.js",
      "--acp",
    ]);
    expect(wrapped.permissionCli?.insertAfterArgs).toBe(4);
    expect(wrapped.modelCli?.listArgs).toEqual([
      "/plugin/host.js",
      "--acp-compat-proxy=codebuddy",
      "agent",
      "entry.js",
      "--list-models",
    ]);
    expect(wrapped.env).toEqual(original.env);
    expect(wrapped.nativeSkillRoots).toEqual(original.nativeSkillRoots);
    expect(original.args).toEqual(["entry.js", "--acp"]);
    expect(() =>
      wrapLaunch(wrapped, "codebuddy", "/node", "/plugin/host.js"),
    ).toThrow(/already wrapped/);
  });
});
