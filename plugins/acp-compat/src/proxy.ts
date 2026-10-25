import { randomUUID } from "node:crypto";
import type { AcpAdapter } from "./adapters/types.js";
import { record, type Id, type Message } from "./wire.js";

interface Job {
  message: Message & { id: Id };
  retries: number;
  recovery: boolean;
  notBefore: number;
}
interface Steer {
  id: Id;
  session: Session;
  owner: string;
  messageId: string;
  accepted: boolean;
  inserted: boolean;
}
interface Session {
  active: Job | null;
  queue: Job[];
  owner: string | null;
  epoch: number;
  lastCancel: number;
  timer: ReturnType<typeof setTimeout> | null;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  cancelMessage: Message | null;
  cancelRetries: number;
  steers: Map<string, Steer>;
}
interface Pending {
  reply(message: Message): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class AcpProxy {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Pending>();
  private readonly upstream = new Set<Id>();
  private serial = 0;
  private native = false;
  private closed = false;

  constructor(
    private readonly adapter: AcpAdapter,
    private readonly sendUp: (message: Message) => void,
    private readonly sendDown: (message: Message) => void,
  ) {}

  private session(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        active: null,
        queue: [],
        owner: null,
        epoch: 0,
        lastCancel: 0,
        timer: null,
        cancelTimer: null,
        cancelMessage: null,
        cancelRetries: 0,
        steers: new Map(),
      };
      this.sessions.set(id, session);
    }
    return session;
  }

  private reply(id: Id, message: Message): void {
    if (!this.upstream.delete(id)) return;
    this.sendUp({ ...message, id });
  }

  private fail(id: Id, message: string, code = -32000): void {
    this.reply(id, { jsonrpc: "2.0", error: { code, message } });
  }

  private request(
    message: Message,
    reply: (message: Message) => void,
    timeout?: number,
  ): void {
    const id = `__acp_compat_${++this.serial}`;
    const pending: Pending = { reply };
    this.pending.set(id, pending);
    if (timeout !== undefined)
      pending.timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reply({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "ACP compatibility probe or admission timed out",
          },
        });
      }, timeout);
    this.sendDown({ ...message, id });
  }

  fromClient(message: Message): void {
    if (this.closed) return;
    if (!message.method) {
      this.sendDown(message);
      return;
    }
    if (message.id !== undefined) {
      if (this.upstream.has(message.id)) {
        this.sendUp({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32600, message: "Duplicate active request id" },
        });
        return;
      }
      this.upstream.add(message.id);
    }
    const id = message.id;
    if (message.method === "initialize" && id !== undefined) {
      this.request(message, (reply) => {
        const steering = this.adapter.steering;
        if (!reply.result || !steering) {
          this.reply(id, reply);
          return;
        }
        this.request(
          steering.probe,
          (probe) => {
            this.native = steering.supported(probe);
            this.reply(id, {
              ...reply,
              result: {
                ...reply.result,
                _meta: {
                  ...record(reply.result?._meta),
                  midTurnSteering: this.native,
                },
              },
            });
          },
          3000,
        );
      });
      return;
    }
    const sid = message.params?.sessionId;
    if (this.adapter.serialize && typeof sid === "string") {
      const session = this.session(sid);
      if (message.method === "session/cancel" && id === undefined) {
        this.cancel(sid, session, message);
        return;
      }
      if (message.method === "session/prompt" && id !== undefined) {
        if (this.native && session.active && !session.cancelMessage) {
          this.inject(session, { ...message, id });
          return;
        }
        const now = Date.now(),
          recovery = session.lastCancel > 0 && now - session.lastCancel < 3000;
        session.queue.push({
          message: { ...message, id },
          retries: 0,
          recovery,
          notBefore: now + (recovery ? 100 : 0),
        });
        this.pump(sid, session);
        return;
      }
    }
    if (id === undefined) this.sendDown(message);
    else this.request(message, (reply) => this.reply(id, reply));
  }

  fromAgent(message: Message): void {
    if (this.closed) return;
    if (
      !message.method &&
      typeof message.id === "string" &&
      message.id.startsWith("__acp_compat_")
    ) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.reply(message);
      }
      return;
    }
    const observed = this.adapter.steering?.observe(message);
    let inserted: Steer | undefined;
    if (observed) {
      const session = this.sessions.get(observed.sessionId);
      if (session?.active) session.owner = observed.owner;
      inserted = observed.insertedId
        ? session?.steers.get(observed.insertedId)
        : undefined;
      if (inserted?.owner === observed.owner) inserted.inserted = true;
      else inserted = undefined;
    }
    this.sendUp(message);
    if (inserted) this.settleSteer(inserted);
  }

  private inject(session: Session, message: Message & { id: Id }): void {
    const steering = this.adapter.steering;
    const sid = message.params?.sessionId,
      owner = session.owner;
    const messageId = randomUUID();
    const native =
      steering && owner && typeof sid === "string"
        ? steering.prepare(message.params?.prompt, sid, owner, messageId)
        : null;
    if (!native || !owner || !steering) {
      this.fail(
        message.id,
        "Prompt already in flight; this input requires interrupt delivery",
        -32602,
      );
      return;
    }
    const entry: Steer = {
      id: message.id,
      session,
      owner,
      messageId,
      accepted: false,
      inserted: false,
    };
    session.steers.set(messageId, entry);
    this.request(
      native,
      (reply) => {
        if (!session.steers.has(messageId)) return;
        if (steering.accepted(reply, owner)) {
          entry.accepted = true;
          this.settleSteer(entry);
        } else {
          session.steers.delete(messageId);
          if (entry.inserted || reply.error?.code === -32000)
            this.fail(
              entry.id,
              "Steer admission could not be confirmed safely",
            );
          else
            this.fail(
              entry.id,
              "Prompt already in flight; native steering was not confirmed",
              -32602,
            );
        }
      },
      3000,
    );
  }

  private settleSteer(entry: Steer): void {
    if (!entry.accepted || !entry.inserted) return;
    entry.session.steers.delete(entry.messageId);
    this.reply(entry.id, {
      jsonrpc: "2.0",
      result: { stopReason: "end_turn" },
    });
  }

  private cancel(sid: string, session: Session, message: Message): void {
    session.epoch++;
    session.lastCancel = Date.now();
    session.cancelMessage = session.active ? message : null;
    session.cancelRetries = 0;
    clearTimeout(session.timer ?? undefined);
    session.timer = null;
    clearTimeout(session.cancelTimer ?? undefined);
    session.cancelTimer = null;
    for (const job of session.queue.splice(0))
      this.reply(job.message.id, {
        jsonrpc: "2.0",
        result: { stopReason: "cancelled" },
      });
    for (const steer of session.steers.values()) {
      if (steer.inserted)
        this.reply(steer.id, {
          jsonrpc: "2.0",
          result: { stopReason: "end_turn" },
        });
      else
        this.fail(
          steer.id,
          "Run was cancelled before steer insertion could be confirmed",
        );
    }
    session.steers.clear();
    this.sendDown(message);
    this.retryCancel(session);
    this.pump(sid, session);
  }

  private retryCancel(session: Session): void {
    if (
      !session.active ||
      !session.cancelMessage ||
      session.cancelRetries >= 20
    )
      return;
    session.cancelTimer = setTimeout(() => {
      session.cancelTimer = null;
      if (!session.active || !session.cancelMessage) return;
      session.cancelRetries++;
      session.lastCancel = Date.now();
      this.sendDown(session.cancelMessage);
      this.retryCancel(session);
    }, 100);
  }

  private pump(sid: string, session: Session): void {
    if (this.closed || session.active || session.timer || !session.queue.length)
      return;
    const job = session.queue[0];
    const delay = Math.max(
      0,
      job.notBefore - Date.now(),
      session.lastCancel ? session.lastCancel + 250 - Date.now() : 0,
    );
    if (delay > 0) {
      session.timer = setTimeout(() => {
        session.timer = null;
        this.pump(sid, session);
      }, delay);
      return;
    }
    session.queue.shift();
    session.active = job;
    session.owner = null;
    const epoch = session.epoch;
    this.request(job.message, (reply) => {
      clearTimeout(session.cancelTimer ?? undefined);
      session.cancelTimer = null;
      session.cancelMessage = null;
      session.active = null;
      session.owner = null;
      for (const steer of session.steers.values()) {
        if (steer.inserted) continue;
        session.steers.delete(steer.messageId);
        this.fail(
          steer.id,
          "Active run ended without the required steer insertion receipt",
        );
      }
      if (
        reply.result?.stopReason === "cancelled" &&
        job.recovery &&
        session.epoch === epoch &&
        Date.now() - session.lastCancel < 3000 &&
        job.retries < 5
      ) {
        job.notBefore = Date.now() + Math.min(400, 50 * 2 ** job.retries++);
        session.queue.unshift(job);
      } else this.reply(job.message.id, reply);
      this.pump(sid, session);
    });
  }

  close(reason = "ACP agent exited before replying"): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    for (const session of this.sessions.values()) {
      clearTimeout(session.timer ?? undefined);
      clearTimeout(session.cancelTimer ?? undefined);
    }
    this.sessions.clear();
    for (const id of this.upstream) this.fail(id, reason);
  }
}
