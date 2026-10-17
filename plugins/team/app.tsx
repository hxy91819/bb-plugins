import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { FormEvent } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, Member, Avatar } from "./src/contracts.js";
import { createIdentityStore } from "./src/identity.js";
import { memberId as memberIdSchema } from "./src/member-id.js";
import { ownerLabel, useOwnership } from "./src/thread-list.js";
import { PersistentResponsiveDrawerShell } from "./components/ui/responsive-overlay.js";
import { useIsCompactViewport } from "./components/ui/hooks/use-compact-viewport.js";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

type TeamState = {
  adminMemberId: string | null;
  serverScope: string;
  timezone: string;
  timezoneConfigured: boolean;
  threadIntegration: boolean;
};
const identities = new Map<string, ReturnType<typeof createIdentityStore>>();
let activeIdentity: ReturnType<typeof createIdentityStore> | null = null;
let identitySignal: AbortSignal | null = null;
let identityFailure = "Team identity is loading. Wait and submit again.";
function identityFor(scope: string) {
  let identity = identities.get(scope);
  if (!identity) {
    identity = createIdentityStore(
      scope,
      () => window.localStorage,
      () => window.sessionStorage,
    );
    identities.set(scope, identity);
  }
  activeIdentity = identity;
  return identity;
}
function useTeam() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<TeamState | null>(null);
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const fetchEpoch = useRef(0);
  const report = useCallback(
    (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    [],
  );
  const refresh = useCallback(() => {
    const epoch = ++fetchEpoch.current;
    setRevision((v) => v + 1);
    void Promise.all([rpc.call("state"), rpc.call("avatars_list")]).then(
      ([next, list]) => {
        if (epoch !== fetchEpoch.current) return;
        setState(next);
        setAvatars(list);
        setError(null);
      },
      (cause) => {
        if (epoch === fetchEpoch.current) report(cause);
      },
    );
  }, [rpc, report]);
  useEffect(() => {
    refresh();
    return () => {
      fetchEpoch.current++;
    };
  }, [refresh]);
  useRealtime("members.changed", refresh);
  useRealtime("settings.changed", refresh);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection, refresh]);
  return { rpc, state, avatars, error, report, refresh, revision };
}

const pickerListeners = new Set<() => void>();
let pickerRequest = 0;
function requestPicker() {
  pickerRequest++;
  pickerListeners.forEach((fn) => fn());
}
const subscribePicker = (fn: () => void) => {
  pickerListeners.add(fn);
  return () => {
    pickerListeners.delete(fn);
  };
};
const iconListeners = new Set<() => void>();
let iconAvatar: string | null = null;
const subscribeIcon = (fn: () => void) => {
  iconListeners.add(fn);
  return () => {
    iconListeners.delete(fn);
  };
};
function IdentityIcon({ className }: { className?: string }) {
  const src = useSyncExternalStore(subscribeIcon, () => iconAvatar);
  return src ? (
    <img src={src} alt="" className={className + " rounded-full"} />
  ) : (
    <span className={className} aria-hidden="true">
      ◉
    </span>
  );
}
function AvatarImage({
  member,
  avatars,
  small = false,
}: {
  member: Member;
  avatars: Avatar[];
  small?: boolean;
}) {
  const avatar = avatars.find((a) => a.id === member.avatarId);
  return avatar ? (
    <img
      src={avatar.url}
      alt=""
      width={small ? 28 : 40}
      height={small ? 28 : 40}
      className={`${small ? "size-7" : "size-10"} shrink-0 rounded-full`}
    />
  ) : null;
}
function ResponsivePanel({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  children: import("react").ReactNode;
}) {
  const compact = useIsCompactViewport();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    return () => {
      if (element.open) element.close();
    };
  }, [open, compact]);
  const content = (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-medium">{title}</h2>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          关闭
        </Button>
      </div>
      {children}
    </div>
  );
  return compact ? (
    <PersistentResponsiveDrawerShell
      open={open}
      onOpenChange={onOpenChange}
      srLabel={title}
      contentClassName="bg-background text-foreground"
    >
      {content}
    </PersistentResponsiveDrawerShell>
  ) : (
    <dialog
      ref={dialog}
      aria-label={title}
      className="fixed inset-0 m-auto max-h-[85vh] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/30"
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      {content}
    </dialog>
  );
}
function ProfileForm({
  avatars,
  member,
  title,
  submit,
}: {
  avatars: Avatar[];
  member?: Member;
  title: string;
  submit: (profile: { displayName: string; avatarId: string }) => Promise<void>;
}) {
  const [displayName, setName] = useState(member?.displayName ?? "");
  const [avatarId, setAvatar] = useState(member?.avatarId ?? "cat");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await submit({ displayName, avatarId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="space-y-4" onSubmit={save}>
      <label className="block space-y-1 text-sm">
        姓名
        <Input
          aria-label="成员姓名"
          value={displayName}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <fieldset>
        <legend className="mb-2 text-sm">头像</legend>
        <div className="flex flex-wrap gap-2">
          {avatars
            .filter((a) => a.id !== "admin")
            .map((a) => (
              <button
                key={a.id}
                type="button"
                aria-label={a.name}
                aria-pressed={avatarId === a.id}
                onClick={() => setAvatar(a.id)}
                className={`rounded-full p-1 ring-2 ${avatarId === a.id ? "ring-ring" : "ring-transparent"}`}
              >
                <img
                  src={a.url}
                  alt={a.alt}
                  width={48}
                  height={48}
                  className="size-12 rounded-full"
                />
              </button>
            ))}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        type="submit"
        disabled={
          pending || !displayName.trim() || [...displayName.trim()].length > 80
        }
      >
        {pending ? "保存中…" : title}
      </Button>
    </form>
  );
}
function IdentityOverlay({
  listSupported = true,
}: {
  listSupported?: boolean;
}) {
  const team = useTeam();
  return team.state ? (
    <>
      {!listSupported && (
        <p
          role="alert"
          className="fixed right-3 bottom-32 z-40 max-w-xs rounded-lg border bg-background p-3 text-sm"
        >
          成员列表需要支持列表贡献 v2 的 BB，请升级到 README 指定的兼容版本。
        </p>
      )}
      <ReadyIdentity team={{ ...team, state: team.state }} />
    </>
  ) : (
    <div
      className="fixed right-3 bottom-20 z-40 rounded-lg border border-border bg-background p-2 text-sm"
      role="status"
    >
      {team.error ? (
        <>
          <span role="alert">身份加载失败</span>
          <Button variant="ghost" onClick={team.refresh}>
            重试
          </Button>
        </>
      ) : (
        "正在加载身份…"
      )}
    </div>
  );
}
function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
function ReadyIdentity({
  team,
}: {
  team: ReturnType<typeof useTeam> & { state: TeamState };
}) {
  const { rpc, state, avatars, revision, refresh } = team;
  const compact = useIsCompactViewport();
  const identity = identityFor(
    JSON.stringify([location.origin, state.serverScope]),
  );
  const choice = useSyncExternalStore(identity.subscribe, identity.getSnapshot);
  const request = useSyncExternalStore(subscribePicker, () => pickerRequest);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"picker" | "edit" | "create">("picker");
  const [validation, setValidation] = useState<{
    id: string | null;
    status: "loading" | "ready" | "error";
    member: Member | null;
    error?: string;
  }>({ id: choice.memberId, status: "loading", member: null });
  const current =
    validation.id === choice.memberId
      ? validation
      : { id: choice.memberId, status: "loading" as const, member: null };
  const selected = current.member;
  const prompted = useRef(new Set<string | null>());
  const [members, setMembers] = useState<Member[]>([]);
  const [search, setSearch] = useState("");
  const [after, setAfter] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [listStatus, setListStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [listError, setListError] = useState("");
  const [selectError, setSelectError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [timezone, setTimezone] = useState(() =>
    state.timezoneConfigured ? state.timezone : browserTimezone(),
  );
  const [timezoneError, setTimezoneError] = useState<string | null>(null);
  useEffect(() => {
    if (state.timezoneConfigured) setTimezone(state.timezone);
  }, [state.timezone, state.timezoneConfigured]);
  useEffect(() => {
    if (request) {
      setView("picker");
      setOpen(true);
    }
  }, [request]);
  useEffect(() => {
    let active = true;
    if (
      choice.memberId !== null &&
      !memberIdSchema.safeParse(choice.memberId).success
    ) {
      setValidation({ id: choice.memberId, status: "ready", member: null });
      return;
    }
    setValidation((previous) => ({
      id: choice.memberId,
      status: "loading",
      member: previous.id === choice.memberId ? previous.member : null,
    }));
    void rpc.call("identity_validate", { memberId: choice.memberId }).then(
      (value) => {
        if (active)
          setValidation({
            id: choice.memberId,
            status: "ready",
            member: value.member,
          });
      },
      (cause) => {
        if (active)
          setValidation((previous) => ({
            id: choice.memberId,
            status: "error",
            member: previous.id === choice.memberId ? previous.member : null,
            error: String(cause),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, choice.memberId, revision]);
  useEffect(() => {
    if (
      current.status === "ready" &&
      !current.member &&
      !prompted.current.has(choice.memberId)
    ) {
      prompted.current.add(choice.memberId);
      setView("picker");
      setOpen(true);
    }
  }, [current.status, current.member, choice.memberId]);
  useEffect(() => {
    iconAvatar = selected
      ? (avatars.find((a) => a.id === selected.avatarId)?.url ?? null)
      : null;
    iconListeners.forEach((fn) => fn());
    return () => {
      iconAvatar = null;
      iconListeners.forEach((fn) => fn());
    };
  }, [selected, avatars]);
  useEffect(() => {
    if (!open || view !== "picker") return;
    let active = true;
    setListStatus("loading");
    void rpc.call("members_list", { search, cursor: after, limit: 20 }).then(
      (page) => {
        if (active) {
          setMembers(page.members);
          setNext(page.nextCursor);
          setListStatus("ready");
        }
      },
      (cause) => {
        if (active) {
          setListStatus("error");
          setListError(String(cause));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, open, view, search, after, revision]);
  async function choose(memberId: string, remember = true) {
    if (selecting) return;
    setSelecting(true);
    setSelectError(null);
    try {
      const value = await rpc.call("identity_validate", { memberId });
      if (!value.valid || !value.member)
        throw Error("该成员已失效，请选择其他身份。");
      identity.select(memberId, remember);
      setValidation({ id: memberId, status: "ready", member: value.member });
      setOpen(false);
    } catch (cause) {
      setSelectError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSelecting(false);
    }
  }
  const label =
    current.status === "loading"
      ? "正在加载身份…"
      : current.status === "error"
        ? "身份加载失败"
        : (selected?.displayName ?? "选择身份");
  return (
    <>
      <span
        title={selected ? `当前身份：${selected.displayName}，点击切换` : label}
      >
        <Button
          variant="outline"
          className={`fixed right-3 z-40 max-w-[11rem] gap-2 rounded-full bg-background shadow-md ${compact ? "top-12" : "bottom-20"}`}
          aria-label={
            selected ? `当前身份：${selected.displayName}，切换身份` : label
          }
          onClick={() => {
            setView("picker");
            setOpen(true);
          }}
        >
          {selected && (
            <AvatarImage member={selected} avatars={avatars} small />
          )}
          <span className="truncate">{label}</span>
        </Button>
      </span>
      <ResponsivePanel
        open={open}
        onOpenChange={setOpen}
        title={
          view === "edit"
            ? "编辑资料"
            : view === "create"
              ? "创建成员"
              : "选择团队身份"
        }
      >
        {view !== "picker" && (
          <Button variant="ghost" onClick={() => setView("picker")}>
            返回身份选择
          </Button>
        )}
        {view === "edit" &&
          selected &&
          selected.memberId !== state.adminMemberId && (
            <ProfileForm
              key={selected.memberId}
              member={selected}
              avatars={avatars}
              title="保存资料"
              submit={async (profile) => {
                await rpc.call("members_updateSelf", {
                  ...profile,
                  memberId: selected.memberId,
                });
                setView("picker");
                refresh();
              }}
            />
          )}
        {view === "create" && selected?.memberId === state.adminMemberId && (
          <ProfileForm
            avatars={avatars}
            title="创建成员"
            submit={async (profile) => {
              await rpc.call("members_create", {
                ...profile,
                actorMemberId: selected.memberId,
              });
              setView("picker");
              setSearch("");
              setAfter(null);
              refresh();
            }}
          />
        )}
        {view === "picker" && (
          <>
            {!state.threadIntegration && (
              <p role="alert">
                线程归属、成员分组和活动查询需要 README 指定的兼容 BB
                fork；当前宿主不支持这些接口。
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              选择后，新会话会记在该成员名下。
            </p>
            {current.status === "loading" && (
              <p role="status">正在确认当前身份…</p>
            )}
            {current.status === "error" && (
              <p role="alert">
                无法确认当前身份。
                <Button variant="ghost" onClick={refresh}>
                  重试
                </Button>
              </p>
            )}
            {current.status === "ready" && !selected && choice.memberId && (
              <p role="alert">已保存的身份失效，请重新选择。</p>
            )}
            {selected && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
                <AvatarImage member={selected} avatars={avatars} />
                <span className="min-w-0 flex-1 break-words">
                  当前：{selected.displayName}
                </span>
                {selected.memberId === state.adminMemberId ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      管理员
                    </span>
                    <Button onClick={() => setView("create")}>创建成员</Button>
                  </>
                ) : (
                  <Button variant="outline" onClick={() => setView("edit")}>
                    编辑资料
                  </Button>
                )}
              </div>
            )}
            {team.error && (
              <p role="alert">
                团队信息加载失败：{team.error}
                <Button variant="ghost" onClick={refresh}>
                  重试
                </Button>
              </p>
            )}
            {choice.warning && <p role="alert">{choice.warning}</p>}
            {selectError && (
              <p role="alert" className="text-destructive">
                {selectError}
              </p>
            )}
            <Input
              aria-label="搜索成员"
              placeholder="搜索成员"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setAfter(null);
              }}
            />
            {listStatus === "loading" ? (
              <p role="status">正在加载成员…</p>
            ) : listStatus === "error" ? (
              <div role="alert">
                成员加载失败：{listError}
                <Button variant="ghost" onClick={refresh}>
                  重试
                </Button>
              </div>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {members.map((member) => (
                  <li
                    key={member.memberId}
                    className="flex items-center gap-3 p-3"
                  >
                    <AvatarImage member={member} avatars={avatars} />
                    <span className="min-w-0 flex-1 break-words">
                      {member.displayName}
                      {member.memberId === state.adminMemberId && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          管理员
                        </span>
                      )}
                    </span>
                    <Button
                      disabled={selecting}
                      aria-label={`选择 ${member.displayName}`}
                      onClick={() => void choose(member.memberId)}
                    >
                      选择
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {listStatus === "ready" && members.length === 0 && (
              <p role="status">没有匹配的成员。</p>
            )}
            <div className="flex gap-2">
              {after && (
                <Button variant="outline" onClick={() => setAfter(null)}>
                  第一页
                </Button>
              )}
              {next && (
                <Button
                  variant="outline"
                  disabled={listStatus !== "ready"}
                  onClick={() => setAfter(next)}
                >
                  下一页
                </Button>
              )}
            </div>
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                更多选项
              </summary>
              <div className="mt-3 space-y-3">
                <p className="text-xs text-muted-foreground">
                  常规选择会记住身份，但不会切换其他已打开窗口的身份。
                </p>
                {selected && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      prompted.current.add(null);
                      identity.select(null, false);
                      setOpen(false);
                    }}
                  >
                    此窗口暂不选择身份
                  </Button>
                )}
                <Button variant="outline" onClick={identity.restoreDefault}>
                  使用上次记住的身份
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    prompted.current.add(null);
                    identity.forgetDefault();
                    setOpen(false);
                  }}
                >
                  忘记已记住的身份
                </Button>
                {listStatus === "ready" && (
                  <div className="flex flex-wrap gap-2">
                    {members.map((member) => (
                      <Button
                        key={member.memberId}
                        variant="ghost"
                        disabled={selecting}
                        onClick={() => void choose(member.memberId, false)}
                      >{`仅此窗口选择 ${member.displayName}`}</Button>
                    ))}
                  </div>
                )}
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setTimezoneError(null);
                    void rpc
                      .call("timezone_set", { timezone })
                      .then(refresh, (cause) =>
                        setTimezoneError(String(cause)),
                      );
                  }}
                >
                  <label className="text-sm">
                    团队时区
                    <Input
                      aria-label="团队时区"
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                    />
                  </label>
                  {timezoneError && <p role="alert">{timezoneError}</p>}
                  <Button variant="outline">保存时区</Button>
                </form>
                <p className="text-xs text-muted-foreground">
                  身份由团队成员自选，不是登录或权限认证。
                </p>
              </div>
            </details>
          </>
        )}
      </ResponsivePanel>
    </>
  );
}
function UnsupportedTeamPage() {
  return (
    <p role="alert" className="p-4">
      此 BB 缺少团队身份所需的公开界面接口，请使用 README 指定的兼容 BB fork。
    </p>
  );
}
function TeamPage() {
  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-medium">团队身份</h1>
      <p>在主界面的身份按钮中选择或切换成员；Admin 可创建成员。</p>
      <Button onClick={requestPicker}>选择团队身份</Button>
    </div>
  );
}
export default definePluginApp((app) => {
  const hasIdentityUi =
    typeof app.slots.experimental_appOverlay === "function" &&
    typeof app.experimental_icons?.register === "function" &&
    typeof app.experimental_sidebarFooter?.register === "function";
  const hasThreadCreation =
    typeof app.experimental_threadCreationContext?.register === "function";
  const hasGrouping =
    typeof app.slots.experimental_threadListGrouping === "function";
  const hasRowDecoration =
    typeof app.slots.experimental_threadRowDecoration === "function";
  const hasListV2 = app.experimental_threadListContributionVersion >= 2;
  const hasThreadIntegration =
    hasThreadCreation && hasGrouping && hasRowDecoration;
  if (hasThreadIntegration) {
    app.experimental_threadCreationContext.register({
      capture: () => {
        if (!activeIdentity || !identitySignal || identitySignal.aborted)
          throw Error(identityFailure);
        return { memberId: activeIdentity.getSnapshot().memberId };
      },
    });
    app.contentScripts.register({
      id: "window-identity",
      mount: async ({ pluginId, signal }) => {
        activeIdentity = null;
        identitySignal = signal;
        identityFailure = "Team identity is loading. Wait and submit again.";
        try {
          const response = await fetch(
            `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/state`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "null",
              signal,
            },
          );
          const result: unknown = await response.json();
          if (
            !response.ok ||
            typeof result !== "object" ||
            result === null ||
            !("ok" in result) ||
            result.ok !== true ||
            !("result" in result) ||
            typeof result.result !== "object" ||
            result.result === null ||
            !("serverScope" in result.result) ||
            typeof result.result.serverScope !== "string"
          )
            throw Error(
              "Cannot load Team identity. Reconnect or reload before creating an attributed thread.",
            );
          if (!signal.aborted)
            identityFor(
              JSON.stringify([location.origin, result.result.serverScope]),
            );
        } catch (cause) {
          if (!signal.aborted)
            identityFailure =
              cause instanceof Error ? cause.message : String(cause);
        }
        return () => {
          if (identitySignal === signal) {
            activeIdentity = null;
            identitySignal = null;
          }
        };
      },
    });
  }
  if (hasThreadIntegration && hasListV2) {
    app.slots.experimental_threadListGrouping({
      id: "members",
      title: "Team members",
      useData: useOwnership,
      projection: ({ thread, data }) =>
        data.status !== "ready"
          ? { status: data.status }
          : { status: "ready", group: ownerLabel(thread.id, data) },
    });
  }
  if (hasThreadIntegration && hasListV2) {
    app.slots.experimental_threadRowDecoration({
      id: "member",
      title: "Team member",
      useData: useOwnership,
      item: ({ thread, data, groupingKey }) => {
        if (groupingKey === "team/members" || data.status !== "ready")
          return null;
        const owner = ownerLabel(thread.id, data);
        if (!owner.avatar) return null;
        return {
          text: null,
          placement: "leading",
          accessibleLabel: `Thread member: ${owner.label}`,
          avatar: owner.avatar,
        };
      },
    });
  }
  app.slots.navPanel({
    id: "members",
    title: "Team",
    icon: "Users",
    path: "members",
    component: hasIdentityUi && hasListV2 ? TeamPage : UnsupportedTeamPage,
  });
  app.slots.settingsSection({
    id: "members",
    title: "Team members",
    component: hasIdentityUi && hasListV2 ? TeamPage : UnsupportedTeamPage,
  });
  if (hasIdentityUi) {
    app.slots.experimental_appOverlay({
      id: "identity",
      component: () => <IdentityOverlay listSupported={hasListV2} />,
    });
    app.experimental_icons.register({
      name: "team-current-member",
      component: IdentityIcon,
    });
    app.experimental_sidebarFooter.register({
      id: "identity",
      kind: "action",
      label: "选择团队身份",
      icon: "team-current-member",
      onActivate: requestPicker,
    });
  }
});
