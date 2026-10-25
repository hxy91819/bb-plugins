import { z } from "zod";
import { record } from "../wire.js";
import type { AcpAdapter } from "./types.js";
const textBlocks = z
  .array(z.object({ type: z.literal("text"), text: z.string() }).passthrough())
  .min(1);
export const codebuddyAdapter: AcpAdapter = {
  serialize: true,
  steering: {
    probe: { jsonrpc: "2.0", method: "session/steer", params: {} },
    supported(reply) {
      return (
        reply.error?.code === -32602 &&
        [reply.error.message, reply.error.data].some(
          (value) =>
            typeof value === "string" &&
            /Steer operation requires "sessionId"/.test(value),
        )
      );
    },
    prepare(prompt, sessionId, owner, messageId) {
      const parsed = textBlocks.safeParse(prompt);
      if (
        !parsed.success ||
        parsed.data.some((b) => b.text.trimStart().startsWith("/"))
      )
        return null;
      return {
        jsonrpc: "2.0",
        method: "session/steer",
        params: {
          sessionId,
          contentBlocks: parsed.data,
          expectedRequestId: owner,
          clientUserMessageId: messageId,
        },
      };
    },
    accepted(reply, owner) {
      return (
        reply.result?.steered === true && reply.result.ownerRequestId === owner
      );
    },
    observe(message) {
      if (message.method !== "session/update") return null;
      const sid = message.params?.sessionId,
        update = record(message.params?.update);
      const meta = record(update._meta),
        owner = meta["codebuddy.ai/conversationRequestId"];
      if (typeof sid !== "string" || typeof owner !== "string") return null;
      const messageId = update.messageId ?? meta["codebuddy.ai/messageId"];
      return {
        sessionId: sid,
        owner,
        ...(update.sessionUpdate === "user_message_chunk" &&
        typeof messageId === "string"
          ? { insertedId: messageId }
          : {}),
      };
    },
  },
};
