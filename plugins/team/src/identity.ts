export type IdentitySnapshot = {
  memberId: string | null;
  warning: string | null;
};
export type StorageAccess = () => Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;
export function createIdentityStore(
  scope: string,
  local: StorageAccess,
  session: StorageAccess,
) {
  const key = `bb-plugin-team:identity:v1:${scope}`;
  let snapshot: IdentitySnapshot = { memberId: null, warning: null };
  const listeners = new Set<() => void>();
  const memory: {
    local: string | null | undefined;
    session: string | null | undefined;
  } = { local: undefined, session: undefined };
  const access = { local, session };
  const pendingWrite = { local: false, session: false };
  const failure = () => {
    snapshot = {
      ...snapshot,
      warning:
        "浏览器存储不可用；当前选择仅在内存中，无法保证刷新或重开后保留。",
    };
  };
  const read = (kind: "local" | "session") => {
    if (pendingWrite[kind]) return memory[kind];
    try {
      const raw = access[kind]().getItem(key);
      if (raw === null) {
        memory[kind] = undefined;
        return undefined;
      }
      const value: unknown = JSON.parse(raw);
      if (value !== null && typeof value !== "string") {
        snapshot = {
          ...snapshot,
          warning: "已保存的身份格式无效，请重新选择。",
        };
        return null;
      }
      memory[kind] = value;
      return value;
    } catch {
      failure();
      return memory[kind];
    }
  };
  const write = (
    kind: "local" | "session",
    value: string | null | undefined,
  ) => {
    memory[kind] = value;
    try {
      if (value === undefined) access[kind]().removeItem(key);
      else access[kind]().setItem(key, JSON.stringify(value));
      pendingWrite[kind] = false;
    } catch {
      pendingWrite[kind] = true;
      failure();
    }
  };
  const initial = read("session");
  snapshot = {
    ...snapshot,
    memberId: initial === undefined ? (read("local") ?? null) : initial,
  };
  write("session", snapshot.memberId);
  const emit = () => listeners.forEach((fn) => fn());
  const select = (memberId: string | null, remember: boolean) => {
    snapshot = { ...snapshot, memberId };
    if (remember) write("local", memberId);
    write("session", memberId);
    emit();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    select,
    restoreDefault: () => {
      write("session", undefined);
      snapshot = { ...snapshot, memberId: read("local") ?? null };
      write("session", snapshot.memberId);
      emit();
    },
    forgetDefault: () => {
      write("local", undefined);
      select(null, false);
    },
  };
}
