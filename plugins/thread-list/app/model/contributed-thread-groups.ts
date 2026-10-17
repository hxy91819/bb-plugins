import type { experimental_ThreadListContributions } from "@get-bb/plugin-sdk/app";
import { buildContributionGroupKey } from "../../shared/preferences.js";
import { projectRootThreadGroups } from "./project-thread-groups.js";
import type { SidebarThread } from "./sidebar-thread.js";

export function buildContributedThreadGroups(
  threads: readonly SidebarThread[],
  providerKey: string,
  projection: NonNullable<experimental_ThreadListContributions["grouping"]>,
) {
  let failed = false;
  const groups = projectRootThreadGroups(threads, (thread) => {
    const result = projection(thread);
    if (result.status === "error") failed = true;
    if (result.status !== "ready")
      return {
        key: buildContributionGroupKey(providerKey, "loading"),
        label: "Loading groups…",
      };
    return result.group === null
      ? {
          key: buildContributionGroupKey(providerKey, "ungrouped"),
          label: "Ungrouped",
        }
      : {
          ...result.group,
          key: buildContributionGroupKey(
            providerKey,
            "group",
            result.group.key,
          ),
        };
  });
  return { failed, groups };
}
