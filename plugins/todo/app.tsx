import { useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { TODO_CHANGED_EVENT, type TodoSnapshot, type rpcContract } from "./contract";

/**
 * Phase 1 placeholder. Phase 2 replaces this with the Apple Reminders-style
 * panel (quick add, inline edit, inbox triage, thread capsules).
 */
function TodoPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<TodoSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  const load = async () => {
    try {
      setSnapshot(await rpc.call("listSnapshot", {}));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  useEffect(() => {
    void load();
  }, []);
  useRealtime(TODO_CHANGED_EVENT, () => {
    void load();
  });

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4 text-sm">
      <header className="space-y-1">
        <h1 className="text-base font-semibold">Todo</h1>
        <p className="text-xs text-muted-foreground">
          Phase 1 backend is live. The full Apple-style panel lands in phase 2.
        </p>
      </header>
      {failed ? (
        <p className="text-xs text-destructive">Could not load todos.</p>
      ) : snapshot === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Inbox</dt>
          <dd className="text-right tabular-nums">{snapshot.counts.inbox}</dd>
          <dt className="text-muted-foreground">Open</dt>
          <dd className="text-right tabular-nums">{snapshot.counts.open}</dd>
          <dt className="text-muted-foreground">Focus</dt>
          <dd className="text-right tabular-nums">{snapshot.counts.focus}</dd>
          <dt className="text-muted-foreground">Later</dt>
          <dd className="text-right tabular-nums">{snapshot.counts.later}</dd>
          <dt className="text-muted-foreground">Waiting</dt>
          <dd className="text-right tabular-nums">{snapshot.counts.waiting}</dd>
        </dl>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "todo",
    title: "Todo",
    icon: "ListChecks",
    path: "todo",
    component: TodoPanel,
  });
});
