import type { Message } from "../wire.js";
export interface NativeSteering {
  probe: Message;
  supported(reply: Message): boolean;
  prepare(
    prompt: unknown,
    sessionId: string,
    owner: string,
    messageId: string,
  ): Message | null;
  accepted(reply: Message, owner: string): boolean;
  observe(
    message: Message,
  ): { sessionId: string; owner: string; insertedId?: string } | null;
}
export interface AcpAdapter {
  serialize: boolean;
  steering?: NativeSteering;
}
