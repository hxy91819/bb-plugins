import type { PluginRpcClient } from "@get-bb/plugin-sdk";
import type { ActivityInput, TeamContract } from "./contracts.js";
export type TeamClient = PluginRpcClient<TeamContract>;
/** Accept useRpc<TeamContract>() or a caller-supplied typed RPC transport. */
export function createTeamClient(rpc: TeamClient) {
  return {
    initialize: () => rpc.call("initialize", {}),
    list: (search = "", limit = 20, cursor: string | null = null) =>
      rpc.call("members_list", { search, limit, cursor }),
    resolve: (name: string, limit = 10, cursor: string | null = null) =>
      rpc.call("members_resolve", { name, limit, cursor }),
    get: (memberId: string) => rpc.call("members_get", { memberId }),
    activity: (input: ActivityInput) => rpc.call("activity", input),
    create: (actorMemberId: string, displayName: string, avatarId = "cat") =>
      rpc.call("members_create", { actorMemberId, displayName, avatarId }),
    updateSelf: (memberId: string, displayName: string, avatarId = "cat") =>
      rpc.call("members_updateSelf", { memberId, displayName, avatarId }),
    validate: (memberId: string | null) =>
      rpc.call("identity_validate", { memberId }),
    avatars: () => rpc.call("avatars_list"),
    state: () => rpc.call("state"),
    setTimezone: (timezone: string) => rpc.call("timezone_set", { timezone }),
  };
}

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contracts.js";
/** Script/backend callers use the public BB SDK with explicit output schemas. */
export function createTeamSdkClient(
  sdk: Pick<BbPluginApi["sdk"], "plugins">,
  pluginId = "team",
) {
  return {
    initialize: () =>
      sdk.plugins.callRpc({
        pluginId,
        method: "initialize",
        input: {},
        outputSchema: rpcContract.initialize.output,
      }),
    list: (search = "", limit = 20, cursor: string | null = null) =>
      sdk.plugins.callRpc({
        pluginId,
        method: "members_list",
        input: { search, limit, cursor },
        outputSchema: rpcContract.members_list.output,
      }),
    resolve: (name: string, limit = 10, cursor: string | null = null) =>
      sdk.plugins.callRpc({
        pluginId,
        method: "members_resolve",
        input: { name, limit, cursor },
        outputSchema: rpcContract.members_resolve.output,
      }),
    get: (memberId: string) =>
      sdk.plugins.callRpc({
        pluginId,
        method: "members_get",
        input: { memberId },
        outputSchema: rpcContract.members_get.output,
      }),
    activity: (input: ActivityInput) =>
      sdk.plugins.callRpc({
        pluginId,
        method: "activity",
        input,
        outputSchema: rpcContract.activity.output,
      }),
    create: (actorMemberId: string, displayName: string, avatarId = "cat") =>
      sdk.plugins.callRpc({
        pluginId,
        method: "members_create",
        input: { actorMemberId, displayName, avatarId },
        outputSchema: rpcContract.members_create.output,
      }),
    updateSelf: (memberId: string, displayName: string, avatarId = "cat") =>
      sdk.plugins.callRpc({
        pluginId,
        method: "members_updateSelf",
        input: { memberId, displayName, avatarId },
        outputSchema: rpcContract.members_updateSelf.output,
      }),
    validate: (memberId: string | null) =>
      sdk.plugins.callRpc({
        pluginId,
        method: "identity_validate",
        input: { memberId },
        outputSchema: rpcContract.identity_validate.output,
      }),
    avatars: () =>
      sdk.plugins.callRpc({
        pluginId,
        method: "avatars_list",
        input: null,
        outputSchema: rpcContract.avatars_list.output,
      }),
    state: () =>
      sdk.plugins.callRpc({
        pluginId,
        method: "state",
        input: null,
        outputSchema: rpcContract.state.output,
      }),
    setTimezone: (timezone: string) =>
      sdk.plugins.callRpc({
        pluginId,
        method: "timezone_set",
        input: { timezone },
        outputSchema: rpcContract.timezone_set.output,
      }),
  };
}
