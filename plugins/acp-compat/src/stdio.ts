import { spawn } from "node:child_process";
import { experimental_readBoundedLines } from "@get-bb/plugin-sdk/provider-bridge";
import { adapterFor, type AdapterId } from "./adapters/index.js";
import { AcpProxy } from "./proxy.js";
import { messageSchema, type Message } from "./wire.js";

export function runStdio(
  adapter: AdapterId,
  command: string,
  args: string[],
): void {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  const write = (stream: NodeJS.WritableStream, message: Message) =>
    stream.write(JSON.stringify(message) + "\n");
  const proxy = new AcpProxy(
    adapterFor(adapter),
    (m) => write(process.stdout, m),
    (m) => write(child.stdin, m),
  );
  const stop = () => {
    proxy.close("ACP compatibility transport stopped");
    child.kill("SIGTERM");
  };
  for (const [input, receive] of [
    [process.stdin, (m: Message) => proxy.fromClient(m)],
    [child.stdout, (m: Message) => proxy.fromAgent(m)],
  ] as const) {
    experimental_readBoundedLines({
      input,
      onLine(line) {
        try {
          const message = messageSchema.safeParse(JSON.parse(line));
          if (message.success) receive(message.data);
          else if (input === child.stdout) process.stdout.write(line + "\n");
        } catch {
          if (input === child.stdout) process.stdout.write(line + "\n");
          else
            process.stderr.write(
              "ACP compatibility ignored a malformed client line\n",
            );
        }
      },
      onOverflow: stop,
      onClose: input === process.stdin ? stop : undefined,
    });
  }
  child.stderr.pipe(process.stderr);
  child.stdin.on("error", stop);
  child.on("error", (error) => {
    proxy.close(error.message);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    proxy.close();
    process.exitCode = code ?? 1;
    process.stdin.destroy();
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
