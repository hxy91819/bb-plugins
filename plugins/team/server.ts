import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import {
  creationInput,
  memberId,
  rpcContract,
  timezoneSchema,
} from "./src/contracts.js";
import { createMemberService, migrations } from "./src/members.js";
import { createActivityService } from "./src/activity.js";
import { runTeamCli, usage } from "./src/cli.js";
import { loadAvatarAssets } from "./src/avatars.js";
export { rpcContract } from "./src/contracts.js";
export default async function plugin(bb: BbPluginApi) {
  const hasThreadCreation =
    typeof bb.experimental_threadCreationContext?.register === "function";
  const hasActivity =
    typeof bb.sdk.threads.experimental_activity === "function";
  const hasListMetadata =
    typeof bb.sdk.threads.experimental_listPluginMetadata === "function";
  const hasFullSupport = hasThreadCreation && hasActivity && hasListMetadata;
  const assets = loadAvatarAssets();
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const members = createMemberService(db, assets, () =>
    bb.realtime.publish("members.changed", null),
  );
  // Ensure one default administrator before any client can observe the team.
  members.initialize({});
  const settings = bb.settings.define({
    timezone: {
      type: "string",
      label: "团队时区",
      description: "IANA timezone; server defaults to UTC when unset.",
      experimental_schema: timezoneSchema,
    },
  });
  settings.onChange(() => bb.realtime.publish("settings.changed", null));
  const timezones = {
    get: async () => ({ timezone: (await settings.get()).timezone ?? "UTC" }),
    set: (timezone: string) =>
      settings
        .experimental_set({ timezone: timezoneSchema.parse(timezone) })
        .then((value) => ({ timezone: value.timezone ?? "UTC" })),
  };
  let activity: ReturnType<typeof createActivityService> | undefined;
  if (hasFullSupport) {
    activity = createActivityService(bb.sdk, members, timezones.get);
  }
  if (hasFullSupport) {
    bb.experimental_threadCreationContext.register({
      input: creationInput,
      prepare: ({ context, creation, parentMetadata }) => {
        const selected = context.present
          ? context.value.memberId
          : creation.parentThreadId
            ? (parentMetadata?.memberId ?? null)
            : null;
        if (selected === null) return null;
        const id = memberId.parse(selected);
        if (!members.get(id))
          throw Error(
            "Team member no longer exists. Choose an identity again.",
          );
        return { memberId: id };
      },
    });
  }
  const avatars = () =>
    assets.map(({ id, name, file, alt, hash }) => ({
      id,
      name,
      file,
      alt,
      url: `/api/v1/plugins/${encodeURIComponent(bb.pluginId)}/http/avatars/${file}?v=${hash}`,
    }));
  for (const avatar of assets) {
    const bytes = avatar.bytes;
    bb.http.route("GET", `/avatars/${avatar.file}`, (context) => {
      const hash = avatar.hash;
      const etag = `"${hash}"`;
      const headers = {
        "Content-Type": "image/png",
        ETag: etag,
        "Cache-Control":
          context.req.query("v") === hash
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        "X-Content-Type-Options": "nosniff",
      };
      return context.req.header("If-None-Match") === etag
        ? new Response(null, { status: 304, headers })
        : new Response(new Uint8Array(bytes), { headers });
    });
  }
  const handlers: PluginRpcHandlers<typeof rpcContract> = {
    initialize: (input) => members.initialize(input),
    state: async () => {
      const value = await settings.get();
      return {
        serverScope: members.serverScope,
        adminMemberId: members.admin(),
        timezone: value.timezone ?? "UTC",
        timezoneConfigured: value.timezone !== undefined,
        threadIntegration: hasFullSupport,
      };
    },
    members_list: (input) => members.list(input),
    members_resolve: (input) => members.resolve(input),
    members_get: (input) => members.get(input.memberId),
    members_batch: (input) => members.batch(input.memberIds),
    activity:
      activity ??
      (() => {
        throw Error("Activity requires the compatible BB fork.");
      }),
    members_create: (input) => members.create(input),
    members_updateSelf: (input) => members.updateSelf(input),
    identity_validate: (input) => members.validate(input.memberId),
    avatars_list: () => avatars(),
    timezone_set: (input) => timezones.set(input.timezone),
  };
  bb.rpc.register(rpcContract, handlers, {
    experimental_discoverable: true,
    experimental_description: hasFullSupport
      ? "Trusted member profiles and bounded retained activity for attributed threads. Not per-message actor auditing."
      : "Trusted member profiles and identity validation; thread attribution, grouping and activity require the compatible BB fork.",
  });
  bb.cli.register({
    name: "team",
    summary: "团队成员与受信身份资料",
    commands: usage
      .split("\n")
      .filter((s) => s.startsWith("bb team"))
      .map((line) => ({
        name: line.split(" ")[2]!,
        summary: line,
        usage: line + " [--json]",
      })),
    run: runTeamCli(
      members,
      avatars,
      timezones,
      activity ??
        (() => {
          throw Error("Activity requires the compatible BB fork.");
        }),
    ),
  });
}
