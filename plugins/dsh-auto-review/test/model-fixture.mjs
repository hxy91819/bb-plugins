export const name = "bb-dsh-review-smoke";
export const inject = ["llm"];
export function apply(ctx) {
  ctx.on(
    "llm/stream",
    async function* (options) {
      const reviewing = options.system?.startsWith("REVIEW_POLICY\n");
      const mode = process.env.DSH_REVIEW_SMOKE_MODE;
      if (reviewing && mode === "failed") {
        yield {
          type: "finish",
          reason: {
            kind: "error",
            failure: { code: "SERVER", message: "fixture review unavailable" },
          },
        };
        return;
      }
      if (
        !reviewing &&
        !options.messages
          .slice(
            options.messages.findLastIndex(
              (message) => message.role === "user",
            ) + 1,
          )
          .some((message) => message.role === "tool")
      ) {
        const args = JSON.stringify({
          description: "Write the authorized test marker",
          command: "printf reviewed > marker.txt",
        });
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield {
          type: "tool-call-delta",
          index: 0,
          id: "smoke-call-" + options.messages.length,
          name: "bash",
          argumentsDelta: args,
        };
        yield {
          type: "block-end",
          index: 0,
          block: {
            type: "tool-call",
            id: "smoke-call-" + options.messages.length,
            name: "bash",
            arguments: args,
          },
        };
        yield { type: "finish", reason: { kind: "tool-calls" } };
        return;
      }
      const text = reviewing
        ? mode === "malformed"
          ? "{}"
          : JSON.stringify({
              risk: "medium",
              decision: mode === "deny" ? "deny" : "allow",
              ...(mode === "deny"
                ? { reason: "Fixture requires user confirmation." }
                : {}),
            })
        : "SMOKE COMPLETE";
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
    { prepend: true },
  );
}
