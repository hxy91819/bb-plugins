import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { steeringSource } from "@hxy91819/dsh-plugins/acp-steering/source";
import { DshProxy } from "./dsh-proxy.js";
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
  const directory =
    adapter === "dsh"
      ? mkdtempSync(join(tmpdir(), "acp-dsh-steering-"))
      : undefined;
  if (directory) {
    const source = join(directory, "steering.mjs");
    writeFileSync(source, steeringSource, { mode: 0o600 });
    const overlay = join(directory, "steering.yml");
    writeFileSync(
      overlay,
      JSON.stringify([{ insert: [{ id: "bb-acp-steering", name: source }] }]),
      { mode: 0o600 },
    );
    args = [...args, "--patch", overlay];
  }
  const child = spawn(command, args, {
    env: { ...process.env, ...(directory ? { DSH_ACP_STEERING_FD: "3" } : {}) },
    stdio: directory
      ? ["pipe", "pipe", "pipe", "pipe"]
      : ["pipe", "pipe", "pipe"],
  });
  const write = (stream: NodeJS.WritableStream, message: Message) =>
    stream.write(JSON.stringify(message) + "\n");
  const side = child.stdio[3];
  const proxy =
    adapter === "dsh" && side instanceof Duplex
      ? new DshProxy(
          (m) => write(process.stdout, m),
          (m) => write(child.stdin, m),
          (m) => write(side, m),
        )
      : new AcpProxy(
          adapterFor(adapter),
          (m) => write(process.stdout, m),
          (m) => write(child.stdin, m),
        );
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(readyTimer);
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
  if (proxy instanceof DshProxy && side instanceof Duplex) {
    readyTimer = setTimeout(() => {
      proxy.close("DSH steering plugin did not initialize its private channel");
      stop();
    }, 10000);
    experimental_readBoundedLines({
      input: side,
      onLine(line) {
        try {
          const message = messageSchema.parse(JSON.parse(line));
          if (message.method === "ready") clearTimeout(readyTimer);
          proxy.fromSide(message);
        } catch {
          stop();
        }
      },
      onClose: stop,
      onOverflow: stop,
    });
    side.on("error", stop);
  }
  child.stderr.pipe(process.stderr);
  child.stdin.on("error", stop);
  child.on("error", (error) => {
    clearTimeout(readyTimer);
    proxy.close(error.message);
    if (directory) rmSync(directory, { recursive: true, force: true });
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    clearTimeout(readyTimer);
    proxy.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    process.exitCode = code ?? 1;
    process.stdin.destroy();
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
