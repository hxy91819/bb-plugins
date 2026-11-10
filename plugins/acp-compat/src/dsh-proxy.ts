import { z } from "zod";
import { record, type Id, type Message } from "./wire.js";

const textPrompt = z
  .array(z.object({ type: z.literal("text"), text: z.string() }).passthrough())
  .min(1);
interface Session {
  active?: Message & { id: Id };
  ready: boolean;
  originalMessageId?: string;
  cancelled: boolean;
  outcome?: Message;
  barrier: boolean;
  claimed: Set<string>;
  queue: (Message & { id: Id })[];
  steers: Map<
    Id,
    { message: Message & { id: Id }; accepted: boolean; messageId?: string }
  >;
}

export class DshProxy {
  private readonly sessions = new Map<string, Session>();
  private readonly prompts = new Map<Id, Session>();
  private readonly requests = new Map<Id, number>();
  private serial = 0;
  private initialized = false;
  private initialize?: Message;
  private closed = false;

  constructor(
    private readonly sendUp: (message: Message) => void,
    private readonly sendDown: (message: Message) => void,
    private readonly sendSide: (message: Message) => void,
  ) {}

  fromClient(message: Message): void {
    if (this.closed) return;
    if (message.method && message.id !== undefined) {
      if (this.requests.has(message.id)) {
        this.sendUp({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32600, message: "Duplicate active request id" },
        });
        return;
      }
      this.requests.set(message.id, ++this.serial);
    }
    if (message.method === "initialize" && !this.initialized) {
      this.initialize = message;
      return;
    }
    const sid = message.params?.sessionId;
    if (typeof sid === "string") {
      const session = this.sessions.get(sid);
      if (
        message.method === "session/cancel" ||
        message.method === "session/close"
      ) {
        if (session) {
          session.cancelled = session.active !== undefined;
          for (const queued of session.queue.splice(0))
            this.reply(queued.id, {
              jsonrpc: "2.0",
              result: { stopReason: "cancelled" },
            });
        }
        this.sendSide({
          jsonrpc: "2.0",
          method: "cancel",
          params: { sessionId: sid },
        });
      }
      if (message.method === "session/prompt" && message.id !== undefined) {
        const current: Session = session ?? {
          ready: false,
          cancelled: false,
          barrier: false,
          claimed: new Set(),
          queue: [],
          steers: new Map(),
        };
        this.sessions.set(sid, current);
        const prompt = { ...message, id: message.id };
        if (
          current.active &&
          (!textPrompt.safeParse(message.params?.prompt).success ||
            !textPrompt.safeParse(current.active.params?.prompt).success)
        ) {
          this.reply(message.id, {
            jsonrpc: "2.0",
            error: {
              code: -32602,
              message:
                "Prompt already in flight; non-text input requires interrupt delivery",
            },
          });
          return;
        }
        current.queue.push(prompt);
        this.pump(sid, current);
        return;
      }
    }
    this.sendDown(message);
  }

  fromSide(message: Message): void {
    if (this.closed) return;
    if (message.method === "ready") {
      this.initialized = true;
      if (this.initialize) {
        this.sendDown(this.initialize);
        this.initialize = undefined;
      }
      return;
    }
    const sid = message.params?.sessionId;
    if (message.method === "enqueued" && typeof sid === "string") {
      const session = this.sessions.get(sid);
      const original = textPrompt.safeParse(session?.active?.params?.prompt);
      if (
        session &&
        !session.originalMessageId &&
        original.success &&
        typeof message.params?.messageId === "string" &&
        message.params.text ===
          original.data.map((block) => block.text).join("")
      ) {
        session.originalMessageId = message.params.messageId;
      }
      return;
    }
    if (message.method === "claimed" && typeof sid === "string") {
      const session = this.sessions.get(sid);
      if (session && typeof message.params?.messageId === "string")
        session.claimed.add(message.params.messageId);
      if (
        session?.active &&
        !session.outcome &&
        !session.cancelled &&
        message.params?.messageId === session.originalMessageId &&
        session.originalMessageId !== undefined
      ) {
        session.ready = true;
        this.pump(sid, session);
      }
      return;
    }
    if (message.method === "settled" && typeof sid === "string") {
      const session = this.sessions.get(sid);
      if (session?.outcome) {
        session.barrier = true;
        this.finish(session);
      }
      return;
    }
    if (message.id === undefined) return;
    const session = this.prompts.get(message.id);
    const steer = session?.steers.get(message.id);
    if (!session || !steer) return;
    if (
      message.result?.accepted === true &&
      typeof message.result.messageId === "string"
    ) {
      steer.accepted = true;
      steer.messageId = message.result.messageId;
    } else {
      session.steers.delete(message.id);
      this.prompts.delete(message.id);
      if (session.cancelled)
        this.reply(message.id, {
          jsonrpc: "2.0",
          result: { stopReason: "cancelled" },
        });
      else if (message.result?.accepted === false) {
        session.ready = false;
        session.queue.push(steer.message);
      } else
        this.reply(message.id, {
          jsonrpc: "2.0",
          error: message.error ?? {
            code: -32000,
            message: "DSH steer admission failed",
          },
        });
    }
    this.finish(session);
  }

  fromAgent(message: Message): void {
    if (this.closed) return;
    if (message.method || message.id === undefined) {
      this.sendUp(message);
      return;
    }
    const session = this.prompts.get(message.id);
    if (session?.active?.id === message.id) {
      session.outcome = message;
      this.sendSide({
        jsonrpc: "2.0",
        method: "settle",
        params: { sessionId: session.active.params?.sessionId },
      });
      this.finish(session);
      return;
    }
    if (message.result?.agentInfo && this.initialized) {
      message = {
        ...message,
        result: {
          ...message.result,
          _meta: { ...record(message.result._meta), midTurnSteering: true },
        },
      };
    }
    this.reply(message.id!, message);
  }

  private pump(sid: string, session: Session): void {
    if (session.outcome || session.cancelled) return;
    session.queue.sort(
      (a, b) => this.requests.get(a.id)! - this.requests.get(b.id)!,
    );
    if (!session.active) {
      const first = session.queue.shift();
      if (!first) return;
      session.active = first;
      session.ready = false;
      this.prompts.set(first.id, session);
      this.sendDown(first);
    }
    if (!session.ready) return;
    for (const message of session.queue.splice(0)) {
      session.steers.set(message.id, { message, accepted: false });
      this.prompts.set(message.id, session);
      this.sendSide({ ...message, method: "steer" });
    }
  }

  private finish(session: Session): void {
    if (
      !session.outcome ||
      !session.barrier ||
      [...session.steers.values()].some((entry) => !entry.accepted)
    )
      return;
    const outcome = session.outcome;
    const active = session.active;
    session.active = undefined;
    session.outcome = undefined;
    if (!session.cancelled) {
      for (const [id, steer] of session.steers) {
        if (steer.messageId && session.claimed.has(steer.messageId)) continue;
        this.prompts.delete(id);
        session.steers.delete(id);
        this.reply(id, {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "DSH steering was not consumed; its pending input was discarded",
          },
        });
      }
    }
    if (active) {
      this.prompts.delete(active.id);
      this.reply(active.id, outcome);
    }
    for (const id of session.steers.keys()) {
      this.prompts.delete(id);
      this.reply(
        id,
        session.cancelled
          ? { jsonrpc: "2.0", result: { stopReason: "cancelled" } }
          : outcome,
      );
    }
    session.steers.clear();
    session.claimed.clear();
    session.barrier = false;
    session.cancelled = false;
    session.ready = false;
    session.originalMessageId = undefined;
    const sid = active?.params?.sessionId;
    if (typeof sid === "string") this.pump(sid, session);
  }

  private reply(id: Id, message: Message): void {
    if (!this.requests.delete(id)) return;
    this.sendUp({ ...message, id });
  }

  close(reason = "DSH compatibility transport closed before replying"): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.requests.keys())
      this.reply(id, {
        jsonrpc: "2.0",
        error: { code: -32000, message: reason },
      });
    this.sessions.clear();
    this.prompts.clear();
  }
}
