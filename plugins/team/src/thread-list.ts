import { useCallback, useEffect, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { experimental_ThreadListDataInput } from "@get-bb/plugin-sdk/app";
import { memberId } from "./member-id.js";
import type { Avatar, Member, rpcContract } from "./contracts.js";

type OwnershipData = {
  demand: string;
  status: "loading" | "error" | "ready";
  owners: Map<string, string>;
  members: Map<string, Member>;
  avatars: Avatar[];
};
export function useOwnership({
  threadIds,
}: experimental_ThreadListDataInput): OwnershipData {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const demand = JSON.stringify([...new Set(threadIds)].sort());
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useRealtime("members.changed", refresh);
  const connection = useRealtimeConnectionState();
  const [data, setData] = useState<OwnershipData>({
    demand: "",
    status: "loading",
    owners: new Map(),
    members: new Map(),
    avatars: [],
  });
  useEffect(() => {
    const controller = new AbortController();
    const ids: string[] = JSON.parse(demand);
    setData((current) => ({ ...current, demand, status: "loading" }));
    void (async () => {
      const owners = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 200) {
        const page = await sdk.threads.experimental_listPluginMetadata({
          threadIds: ids.slice(i, i + 200),
          signal: controller.signal,
        });
        for (const row of page.threads) {
          if (
            row.metadata.memberId === undefined ||
            row.metadata.memberId === null
          )
            continue;
          owners.set(row.threadId, memberId.parse(row.metadata.memberId));
        }
      }
      const memberIds = [...new Set(owners.values())];
      const members = new Map<string, Member>();
      for (let i = 0; i < memberIds.length; i += 200) {
        for (const member of await rpc.call("members_batch", {
          memberIds: memberIds.slice(i, i + 200),
        }))
          members.set(member.memberId, member);
      }
      if ([...owners.values()].some((id) => !members.has(id)))
        throw Error("member_not_found");
      const avatars = ids.length ? await rpc.call("avatars_list") : [];
      if (!controller.signal.aborted)
        setData({ demand, status: "ready", owners, members, avatars });
    })().catch(() => {
      if (!controller.signal.aborted)
        setData((current) => ({ ...current, demand, status: "error" }));
    });
    return () => controller.abort();
  }, [demand, revision, connection, rpc, sdk]);
  return data.demand === demand ? data : { ...data, status: "loading" };
}
export function ownerLabel(threadId: string, data: OwnershipData) {
  const id = data.owners.get(threadId);
  const member = id ? data.members.get(id) : undefined;
  const avatar = member
    ? data.avatars.find((value) => value.id === member.avatarId)
    : undefined;
  return {
    key: id ?? "unassigned",
    label: member?.displayName ?? "Unassigned",
    avatar: avatar ? { src: avatar.url, alt: member!.displayName } : null,
  };
}
