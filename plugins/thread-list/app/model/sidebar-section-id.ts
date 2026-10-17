export type SidebarSectionId =
  | "pinned"
  | "threads"
  | `project:${string}`
  | `section:${string}`
  | `machine:${string}`
  | `contribution:${string}`;
export type CollapsibleSidebarSectionId = "pinned" | "threads";
