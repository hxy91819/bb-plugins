import { appendFileSync } from "node:fs";
export const name = "steering-fixture";
export const inject = ["llm"];
export function apply(ctx) {
  ctx.on("session/event", (session, event) => {
    if (
      [
        "turn/start",
        "agent/inbox/spliced",
        "user/message",
        "turn/end",
      ].includes(event.type)
    )
      appendFileSync(
        process.env.DSH_STEERING_EVIDENCE,
        JSON.stringify({ sessionId: session.id, ...event }) + "\n",
      );
  });
  ctx.on(
    "llm/stream",
    async function* (options) {
      if (options.purpose === "auto-review") {
        appendFileSync(
          process.env.DSH_STEERING_EVIDENCE,
          JSON.stringify({ type: "fixture/review" }) + "\n",
        );
        const text = JSON.stringify({ risk: "medium", decision: "allow" });
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      const start = options.messages.findLastIndex(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "text" && b.text.startsWith("Hold")),
      );
      const text = options.messages
        .slice(start)
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content)
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const tools = options.messages
        .slice(start)
        .filter((m) => m.role === "tool").length;
      const corrected =
        text.includes("USE_CORRECTION") && text.includes("SECOND_CORRECTION");
      appendFileSync(
        process.env.DSH_STEERING_EVIDENCE,
        JSON.stringify({ type: "fixture/input", text }) + "\n",
      );
      const command =
        tools === 0 && !corrected
          ? 'printf "%s" "$$" > tool.pid; touch ready; while [ ! -f release ]; do sleep 0.05; done; printf finished > tool-finished'
          : tools < 2
            ? `printf ${corrected ? "corrected" : "original"} > result`
            : undefined;
      if (command) {
        const args = JSON.stringify({
          description: "Exercise real tool execution",
          command,
        });
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield {
          type: "tool-call-delta",
          index: 0,
          id: `call-${options.messages.length}`,
          name: "bash",
          argumentsDelta: args,
        };
        yield {
          type: "block-end",
          index: 0,
          block: {
            type: "tool-call",
            id: `call-${options.messages.length}`,
            name: "bash",
            arguments: args,
          },
        };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } else {
        const answer = corrected ? "CORRECTED" : "DONE";
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: answer };
        yield {
          type: "block-end",
          index: 0,
          block: { type: "text", text: answer },
        };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    },
    { prepend: true },
  );
}
